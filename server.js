const express = require('express');
const got = require('got');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const app = express();

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB
const TIMEOUT_MS = 120000; 

const PUBLIC_URL = process.env.PUBLIC_URL || null;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// --- Agents ---
const originAgent = {
    http: new http.Agent({ keepAlive: true, maxSockets: 100 }),
    https: new https.Agent({ keepAlive: true, maxSockets: 100 })
};

const internalAgent = {
    http: new http.Agent({ keepAlive: false }),
    https: new https.Agent({ keepAlive: false })
};

function getHash(str) {
    return crypto.createHash('sha1').update(str).digest('hex').slice(0, 16);
}

// --- Endpoint 1: The Cache Unit (Cloudflare sees this) ---
app.get('/chunk', async (req, res) => {
    const { url, idx } = req.query;
    if (!url || idx === undefined) return res.status(400).send('Missing args');

    const chunkIndex = parseInt(idx, 10);
    const start = chunkIndex * CHUNK_SIZE;
    const end = start + CHUNK_SIZE - 1;

    try {
        const stream = got.stream(url, {
            headers: { 'Range': `bytes=${start}-${end}` },
            timeout: { request: TIMEOUT_MS },
            retry: { limit: 5, methods: ['GET'] },
            agent: originAgent,
            isStream: true
        });

        stream.on('response', (originRes) => {
            if (originRes.statusCode >= 400) {
                res.status(originRes.statusCode).end();
                stream.destroy();
                return;
            }

            // --- THE FIX ---
            // Only send Content-Length if Origin provides it.
            // If we force it to 20MB but Origin sends 13KB, the download fails.
            
            const headers = {
                'Content-Type': originRes.headers['content-type'] || 'application/octet-stream',
                'Cache-Control': 'public, max-age=31536000, immutable',
                'ETag': `"${getHash(url)}-${chunkIndex}"`,
                'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
                'Access-Control-Allow-Origin': '*' 
            };

            // Only add Length if strictly known. Otherwise, let it be Chunked.
            if (originRes.headers['content-length']) {
                headers['Content-Length'] = originRes.headers['content-length'];
            }

            res.writeHead(200, headers);
        });
        
        stream.on('error', (err) => { 
            console.error(`Stream error chunk ${chunkIndex}: ${err.message}`);
            if (!res.headersSent) res.status(502).end(); 
        });

        stream.pipe(res);

    } catch (e) { 
        if (!res.headersSent) res.status(500).end(); 
    }
});

// --- Endpoint 2: The Player Interface ---
app.get('/media', async (req, res) => {
    const originUrl = req.query.url;
    if (!originUrl) return res.status(400).send('Missing url');

    const internalHost = PUBLIC_URL || `http://127.0.0.1:${PORT}`;
    const getChunkUrl = (i) => `${internalHost}/chunk?url=${encodeURIComponent(originUrl)}&idx=${i}`;

    try {
        // 1. Get Metadata
        const headRes = await got.head(originUrl, {
            timeout: { request: 5000 },
            agent: originAgent
        }).catch(() => null);

        const totalSize = headRes && headRes.headers['content-length'] ? parseInt(headRes.headers['content-length'], 10) : 0;
        const contentType = (headRes && headRes.headers['content-type']) || 'video/x-matroska';
        
        // 2. Headers
        res.setHeader('ETag', `"${getHash(originUrl)}"`);
        res.setHeader('Last-Modified', "Mon, 01 Jan 2024 00:00:00 GMT");
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-cache');

        // 3. Range Handling
        const rangeHeader = req.headers.range;
        let startByte = 0;
        let endByte = totalSize ? totalSize - 1 : null;

        if (rangeHeader) {
            const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (rangeMatch) {
                startByte = parseInt(rangeMatch[1], 10);
                if (rangeMatch[2]) endByte = parseInt(rangeMatch[2], 10);
            }
            if (totalSize && startByte >= totalSize) {
                res.setHeader('Content-Range', `bytes */${totalSize}`);
                return res.status(416).send('Range Not Satisfiable');
            }
            res.status(206); 
            res.setHeader('Content-Range', `bytes ${startByte}-${endByte || (totalSize ? totalSize - 1 : '*')}/${totalSize || '*'}`);
            res.setHeader('Content-Length', (endByte !== null ? endByte : (totalSize - 1)) - startByte + 1);
        } else {
            res.status(200); 
            if (totalSize) res.setHeader('Content-Length', totalSize);
        }

        if (req.method === 'HEAD') return res.end();

        // 4. Streaming Loop
        const startChunkIdx = Math.floor(startByte / CHUNK_SIZE);
        let currentIdx = startChunkIdx;
        let needsToStop = false;

        const fetchOptions = {
            responseType: 'buffer', 
            timeout: { request: TIMEOUT_MS }, 
            https: { rejectUnauthorized: false }, 
            agent: internalAgent,
            http2: false, 
            throwHttpErrors: false, 
            headers: { 
                'User-Agent': BROWSER_UA,
                'Referer': PUBLIC_URL,
                'Connection': 'close' 
            }
        };

        // Helper to fetch
        const fetchChunk = async (idx) => {
             for (let attempt = 1; attempt <= 2; attempt++) { // Reduced retries to avoid hanging
                 try {
                     const response = await got(getChunkUrl(idx), fetchOptions);
                     const buffer = response.body;
                     
                     if (buffer.length < 20000 && buffer.toString().includes('<!DOCTYPE html>')) {
                        console.error(`[CRITICAL] Cloudflare Challenge triggered on chunk ${idx}`);
                        return { buffer, status: 'blocked' };
                     }
                     return { buffer, status: 'ok' };
                 } catch (e) {
                     await new Promise(r => setTimeout(r, 1000));
                 }
             }
             return { buffer: Buffer.alloc(0), status: 'failed' };
        };

        let nextChunkPromise = fetchChunk(currentIdx);

        while (!needsToStop) {
            let result;
            try { result = await nextChunkPromise; } 
            catch (e) { break; }

            if (result.status === 'blocked' || result.status === 'failed') break;

            const nextIdx = currentIdx + 1;
            const nextStart = nextIdx * CHUNK_SIZE;
            const isLast = (totalSize && nextStart >= totalSize) || (endByte !== null && nextStart > endByte);
            
            if (!isLast && nextIdx < 20000) {
                nextChunkPromise = fetchChunk(nextIdx);
            } else {
                nextChunkPromise = Promise.resolve({ buffer: Buffer.alloc(0), status: 'eof' });
            }

            let buffer = result.buffer;

            // Slicing Logic
            if (currentIdx === startChunkIdx) {
                const relativeStart = startByte % CHUNK_SIZE;
                if (relativeStart > 0) buffer = buffer.slice(relativeStart);
            }
            if (endByte !== null) {
                const chunkStart = currentIdx * CHUNK_SIZE;
                const absBufferStart = chunkStart + (currentIdx === startChunkIdx ? (startByte % CHUNK_SIZE) : 0);
                const needed = (endByte + 1) - absBufferStart;
                if (buffer.length > needed) {
                    buffer = buffer.slice(0, needed);
                    needsToStop = true;
                }
            }
            
            // Logic Update: If buffer is small (header) but we aren't at end of file,
            // we do NOT stop. We just write it and move to next chunk.
            const isEndOfFile = totalSize && (currentIdx * CHUNK_SIZE + result.buffer.length >= totalSize);
            if (result.status === 'eof' || isEndOfFile) needsToStop = true;

            const keepGoing = res.write(buffer);
            if (!keepGoing) await new Promise(r => res.once('drain', r));

            currentIdx++;
            if (currentIdx > 20000) needsToStop = true;
        }
        res.end();
    } catch (err) {
        if (!res.headersSent) res.end();
    }
});

app.listen(PORT, () => console.log(`🚀 Proxy running on port ${PORT}`));
