const express = require('express');
const got = require('got');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const app = express();

// --- Configuration ---
const PORT = process.env.PORT || 8080;
// 20MB is the sweet spot for 4K Remuxes. 
// It reduces HTTP overhead while keeping chunks small enough to manage.
const CHUNK_SIZE = 20 * 1024 * 1024; 
const TIMEOUT_MS = 30000; // 30s timeout for sluggish TorrServer peers

// CRITICAL: Set this to your Cloudflare URL (e.g. https://stream.yourdomain.com)
// If null, it falls back to localhost (Playback works, but caching fails).
const PUBLIC_URL = process.env.PUBLIC_URL || null;

// --- Connection Pooling ---
// Reuses TCP connections to avoid SSL handshake overhead for every chunk
const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 500 // Allow high concurrency for prefetching
};
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

// --- Helpers ---
function getFileHash(url) {
    return crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
}

// --- Endpoint 1: The Cache Unit (Cloudflare sees this) ---
app.get('/chunk', async (req, res) => {
    const { url, idx } = req.query;

    if (!url || idx === undefined) return res.status(400).send('Missing url or idx');

    const chunkIndex = parseInt(idx, 10);
    const start = chunkIndex * CHUNK_SIZE;
    const end = start + CHUNK_SIZE - 1;

    try {
        // Stream directly from Origin (TorrServer)
        const stream = got.stream(url, {
            headers: { 'Range': `bytes=${start}-${end}` },
            timeout: { request: TIMEOUT_MS },
            retry: { limit: 2, methods: ['GET'] },
            agent: { http: httpAgent, https: httpsAgent },
            isStream: true
        });

        stream.on('response', (originRes) => {
            // Forward errors appropriately
            if (originRes.statusCode >= 400) {
                console.error(`[Chunk ${chunkIndex}] Origin Error: ${originRes.statusCode}`);
                res.status(originRes.statusCode).end();
                stream.destroy();
                return;
            }

            // Set Headers for Cloudflare Caching
            res.setHeader('Content-Type', originRes.headers['content-type'] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('ETag', `"${getFileHash(url)}-${chunkIndex}"`);
            
            // Return 200 OK so Cloudflare stores this "file"
            res.status(200);
        });

        stream.on('error', (err) => {
            console.error(`[Chunk ${chunkIndex}] Stream Error: ${err.message}`);
            if (!res.headersSent) res.status(502).end();
        });

        stream.pipe(res);

    } catch (err) {
        if (!res.headersSent) res.status(500).send('Internal Error');
    }
});

// --- Endpoint 2: The Player Interface (You see this) ---
app.get('/media', async (req, res) => {
    const originUrl = req.query.url;
    if (!originUrl) return res.status(400).send('Missing url');

    // Determine where to fetch chunks from. 
    // Ideally PUBLIC_URL (Cloudflare), fallback to Localhost.
    const internalHost = PUBLIC_URL || `http://127.0.0.1:${PORT}`;
    
    // Helper to generate fetch URL
    const getChunkUrl = (i) => `${internalHost}/chunk?url=${encodeURIComponent(originUrl)}&idx=${i}`;

    try {
        // 1. HEAD Request: Get Total File Size
        // Essential for "Resume" functionality and Seeking
        const headRes = await got.head(originUrl, {
            timeout: { request: 5000 },
            agent: { http: httpAgent, https: httpsAgent }
        }).catch(e => null); // If HEAD fails, we proceed with unknown size

        const totalSize = headRes && headRes.headers['content-length'] 
            ? parseInt(headRes.headers['content-length'], 10) 
            : 0;
        
        const contentType = (headRes && headRes.headers['content-type']) || 'video/x-matroska';

        // 2. Parse Range Header (bytes=12345-)
        const rangeHeader = req.headers.range || 'bytes=0-';
        const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        
        let startByte = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;
        let endByte = (rangeMatch && rangeMatch[2]) ? parseInt(rangeMatch[2], 10) : (totalSize ? totalSize - 1 : null);

        // Sanity Check
        if (totalSize && startByte >= totalSize) {
            res.setHeader('Content-Range', `bytes */${totalSize}`);
            return res.status(416).send('Requested Range Not Satisfiable');
        }

        // 3. Send Response Headers (206 Partial Content)
        res.status(206);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-cache'); // Don't cache the stream, only chunks

        if (endByte !== null && totalSize) {
            res.setHeader('Content-Length', endByte - startByte + 1);
            res.setHeader('Content-Range', `bytes ${startByte}-${endByte}/${totalSize}`);
        } else {
            res.setHeader('Content-Range', `bytes ${startByte}-/*`);
        }

        // 4. PREFETCHING LOOP LOGIC
        const startChunkIdx = Math.floor(startByte / CHUNK_SIZE);
        let currentIdx = startChunkIdx;
        let needsToStop = false;

        // Initialize the promise for the FIRST chunk
        let nextChunkPromise = got(getChunkUrl(currentIdx), {
            responseType: 'buffer',
            timeout: { request: TIMEOUT_MS },
            https: { rejectUnauthorized: false }, // Allow self-signed/internal SSL
            agent: { http: httpAgent, https: httpsAgent }
        });

        while (!needsToStop) {
            // A. Wait for the CURRENT chunk to arrive
            let response;
            try {
                response = await nextChunkPromise;
            } catch (err) {
                console.error(`Error fetching internal chunk ${currentIdx}: ${err.message}`);
                break;
            }

            // B. IMMEDIATE PREFETCH: Start downloading NEXT chunk in background
            // We do this BEFORE we process/send the current data
            const nextIdx = currentIdx + 1;
            const nextChunkStart = nextIdx * CHUNK_SIZE;
            
            // Only prefetch if we haven't reached the end of the file or requested range
            const isLastChunk = (totalSize && nextChunkStart >= totalSize) || (endByte !== null && nextChunkStart > endByte);
            
            if (!isLastChunk && nextIdx < 20000) {
                nextChunkPromise = got(getChunkUrl(nextIdx), {
                    responseType: 'buffer',
                    timeout: { request: TIMEOUT_MS },
                    https: { rejectUnauthorized: false },
                    agent: { http: httpAgent, https: httpsAgent }
                });
            } else {
                nextChunkPromise = Promise.resolve(null); // No more chunks needed
            }

            // C. Process Current Chunk (Slicing)
            let buffer = response.body;

            // Slice Start (for seek/resume)
            if (currentIdx === startChunkIdx) {
                const relativeStart = startByte % CHUNK_SIZE;
                if (relativeStart > 0) buffer = buffer.slice(relativeStart);
            }

            // Slice End (for end of file/range)
            if (endByte !== null) {
                const chunkStartPos = currentIdx * CHUNK_SIZE;
                const bufferAbsStart = chunkStartPos + (currentIdx === startChunkIdx ? (startByte % CHUNK_SIZE) : 0);
                const bytesNeeded = (endByte + 1) - bufferAbsStart;
                if (buffer.length > bytesNeeded) {
                    buffer = buffer.slice(0, bytesNeeded);
                    needsToStop = true; // We are done after this write
                }
            }

            // Check for EOF from Origin (Chunk smaller than expected)
            if (response.body.length < CHUNK_SIZE) needsToStop = true;

            // D. Send to Client
            const keepGoing = res.write(buffer);
            if (!keepGoing) {
                // If client is slow, wait for 'drain' event
                await new Promise(resolve => res.once('drain', resolve));
            }

            currentIdx++;
            if (currentIdx > 20000) needsToStop = true; // Safety limit (400GB)
        }

        res.end();

    } catch (err) {
        console.error('Stream error:', err.message);
        if (!res.headersSent) res.end();
    }
});

app.listen(PORT, () => console.log(`🚀 Proxy running on port ${PORT}`));


