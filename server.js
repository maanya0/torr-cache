const express = require('express');
const got = require('got');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const app = express();

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB
const TIMEOUT_MS = 30000; 

// CRITICAL: Set this to your Cloudflare domain
const PUBLIC_URL = process.env.PUBLIC_URL || null;

// Fake Browser User-Agent to bypass Cloudflare Bot Protection
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// --- Connection Pooling ---
const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 500
};
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

// --- Helpers ---
function getHash(str) {
    return crypto.createHash('sha1').update(str).digest('hex').slice(0, 16);
}

// --- Endpoint 1: The Cache Unit ---
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
            retry: { limit: 2, methods: ['GET'] },
            agent: { http: httpAgent, https: httpsAgent },
            isStream: true
        });

        stream.on('response', (originRes) => {
            if (originRes.statusCode >= 400) {
                res.status(originRes.statusCode).end();
                stream.destroy();
                return;
            }

            const chunkLength = originRes.headers['content-length'] || (end - start + 1);

            // Nuclear Fix: Force 200 OK + Whitelist Headers
            const headers = {
                'Content-Type': originRes.headers['content-type'] || 'application/octet-stream',
                'Content-Length': chunkLength,
                'Cache-Control': 'public, max-age=31536000, immutable',
                'ETag': `"${getHash(url)}-${chunkIndex}"`,
                'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
                'Access-Control-Allow-Origin': '*' 
            };

            res.writeHead(200, headers);
        });
        
        stream.on('error', (err) => { 
            console.error(`Stream error chunk ${chunkIndex}: ${err.message}`);
            if (!res.headersSent) res.status(502).end(); 
        });

        stream.pipe(res);

    } catch (e) { 
        console.error(`Setup error chunk ${chunkIndex}: ${e.message}`);
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
            agent: { http: httpAgent, https: httpsAgent }
        }).catch(() => null);

        const totalSize = headRes && headRes.headers['content-length'] ? parseInt(headRes.headers['content-length'], 10) : 0;
        const contentType = (headRes && headRes.headers['content-type']) || 'video/x-matroska';
        
        // 2. Headers
        const fileETag = `"${getHash(originUrl)}"`;
        const lastModified = "Mon, 01 Jan 2024 00:00:00 GMT";

        res.setHeader('ETag', fileETag);
        res.setHeader('Last-Modified', lastModified);
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

        // --- UPDATED: Add User-Agent to internal requests ---
        const fetchOptions = {
            responseType: 'buffer', 
            timeout: { request: TIMEOUT_MS }, 
            https: { rejectUnauthorized: false }, 
            agent: { http: httpAgent, https: httpsAgent },
            headers: { 'User-Agent': BROWSER_UA } // Spoof Browser
        };

        let nextChunkPromise = got(getChunkUrl(currentIdx), fetchOptions);

        while (!needsToStop) {
            let response;
            try { response = await nextChunkPromise; } 
            catch (e) { console.error(`Fetch error chunk ${currentIdx}: ${e.message}`); break; }

            // Prefetch Next
            const nextIdx = currentIdx + 1;
            const nextStart = nextIdx * CHUNK_SIZE;
            const isLast = (totalSize && nextStart >= totalSize) || (endByte !== null && nextStart > endByte);
            
            if (!isLast && nextIdx < 20000) {
                nextChunkPromise = got(getChunkUrl(nextIdx), fetchOptions);
            } else {
                nextChunkPromise = Promise.resolve(null);
            }

            let buffer = response.body;

            // Debug: Check if we got a Cloudflare Block Page
            if (buffer.length < 20000 && buffer.toString().includes('<!DOCTYPE html>')) {
                console.error("CRITICAL: Cloudflare blocked internal request! Check WAF settings.");
                needsToStop = true;
            }

            // Slicing
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
            
            if (response.body.length < CHUNK_SIZE) needsToStop = true;

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
