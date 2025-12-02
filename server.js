const express = require('express');
const got = require('got');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const app = express();

// --- Configuration ---
const PORT = process.env.PORT || 8080;
// 20MB chunks: Best balance for 4K Remuxes
const CHUNK_SIZE = 20 * 1024 * 1024; 
const TIMEOUT_MS = 30000; 

// CRITICAL: Set this to your Cloudflare domain (e.g. https://stream.yourdomain.com)
// If null, it defaults to localhost (Caching will NOT work, but playback will).
const PUBLIC_URL = process.env.PUBLIC_URL || null;

// --- Connection Pooling ---
// Keeps TCP connections open to TorrServer to reduce latency
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
            retry: { limit: 2, methods: ['GET'] },
            agent: { http: httpAgent, https: httpsAgent },
            isStream: true
        });

        stream.on('response', (originRes) => {
            // Forward errors immediately
            if (originRes.statusCode >= 400) {
                res.status(originRes.statusCode).end();
                stream.destroy();
                return;
            }

            // Calculate the exact size of this chunk
            const chunkLength = originRes.headers['content-length'] || (end - start + 1);

            // --- THE NUCLEAR FIX ---
            // We use res.writeHead(200) to forcefully overwrite the status code.
            // This prevents the Origin's "206 Partial Content" from leaking through.
            // We manually construct the header whitelist to ensure Cloudflare caches it.
            
            const headers = {
                // 1. Content Type & Length
                'Content-Type': originRes.headers['content-type'] || 'application/octet-stream',
                'Content-Length': chunkLength,
                
                // 2. Caching Headers (Forces Cloudflare to HIT)
                'Cache-Control': 'public, max-age=31536000, immutable',
                'ETag': `"${getHash(url)}-${chunkIndex}"`,
                'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT', // Static date
                
                // 3. Allow CORS so your browser doesn't complain
                'Access-Control-Allow-Origin': '*' 
            };

            // Write headers immediately. This locks the status as 200.
            res.writeHead(200, headers);
        });
        
        stream.on('error', (err) => { 
            console.error(`Stream error chunk ${chunkIndex}: ${err.message}`);
            // Only send error if headers haven't been sent yet
            if (!res.headersSent) res.status(502).end(); 
        });

        stream.pipe(res);

    } catch (e) { 
        console.error(`Setup error chunk ${chunkIndex}: ${e.message}`);
        if (!res.headersSent) res.status(500).end(); 
    }
});

// --- Endpoint 2: The Player Interface (Resume/Seek Support) ---
app.get('/media', async (req, res) => {
    const originUrl = req.query.url;
    if (!originUrl) return res.status(400).send('Missing url');

    // Use PUBLIC_URL to trigger the Cloudflare Loop, fallback to localhost for internal calls
    const internalHost = PUBLIC_URL || `http://127.0.0.1:${PORT}`;
    const getChunkUrl = (i) => `${internalHost}/chunk?url=${encodeURIComponent(originUrl)}&idx=${i}`;

    try {
        // 1. Get Metadata (Total File Size)
        const headRes = await got.head(originUrl, {
            timeout: { request: 5000 },
            agent: { http: httpAgent, https: httpsAgent }
        }).catch(() => null);

        const totalSize = headRes && headRes.headers['content-length'] ? parseInt(headRes.headers['content-length'], 10) : 0;
        const contentType = (headRes && headRes.headers['content-type']) || 'video/x-matroska';
        
        // 2. Generate Validation Headers (Required for Resume)
        const fileETag = `"${getHash(originUrl)}"`;
        const lastModified = "Mon, 01 Jan 2024 00:00:00 GMT";

        res.setHeader('ETag', fileETag);
        res.setHeader('Last-Modified', lastModified);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-cache'); // Don't cache the stitcher, only chunks

        // 3. Handle Range Header from Client
        const rangeHeader = req.headers.range;
        let startByte = 0;
        let endByte = totalSize ? totalSize - 1 : null;

        if (rangeHeader) {
            const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (rangeMatch) {
                startByte = parseInt(rangeMatch[1], 10);
                if (rangeMatch[2]) endByte = parseInt(rangeMatch[2], 10);
            }
            
            // Validate Range
            if (totalSize && startByte >= totalSize) {
                res.setHeader('Content-Range', `bytes */${totalSize}`);
                return res.status(416).send('Range Not Satisfiable');
            }

            // Return 206 to the CLIENT (Browser), but we fetched 200s from Cloudflare
            res.status(206); 
            res.setHeader('Content-Range', `bytes ${startByte}-${endByte || (totalSize ? totalSize - 1 : '*')}/${totalSize || '*'}`);
            res.setHeader('Content-Length', (endByte !== null ? endByte : (totalSize - 1)) - startByte + 1);
        } else {
            res.status(200); 
            if (totalSize) res.setHeader('Content-Length', totalSize);
        }

        if (req.method === 'HEAD') return res.end();

        // 4. Streaming Loop (Double Buffered / Prefetching)
        const startChunkIdx = Math.floor(startByte / CHUNK_SIZE);
        let currentIdx = startChunkIdx;
        let needsToStop = false;

        // Init Fetch for Chunk 1
        let nextChunkPromise = got(getChunkUrl(currentIdx), {
            responseType: 'buffer', 
            timeout: { request: TIMEOUT_MS }, 
            https: { rejectUnauthorized: false }, 
            agent: { http: httpAgent, https: httpsAgent }
        });

        while (!needsToStop) {
            // A. Wait for Current Chunk
            let response;
            try { response = await nextChunkPromise; } 
            catch (e) { console.error(`Fetch error chunk ${currentIdx}: ${e.message}`); break; }

            // B. Prefetch Next Chunk (Background)
            const nextIdx = currentIdx + 1;
            const nextStart = nextIdx * CHUNK_SIZE;
            const isLast = (totalSize && nextStart >= totalSize) || (endByte !== null && nextStart > endByte);
            
            // Limit prefetching to valid range and sane number of chunks (20,000 ~ 400GB)
            if (!isLast && nextIdx < 20000) {
                nextChunkPromise = got(getChunkUrl(nextIdx), {
                    responseType: 'buffer',
                    timeout: { request: TIMEOUT_MS },
                    https: { rejectUnauthorized: false },
                    agent: { http: httpAgent, https: httpsAgent }
                });
            } else {
                nextChunkPromise = Promise.resolve(null);
            }

            let buffer = response.body;

            // C. Slice Buffer (Precision)
            // Start Slice
            if (currentIdx === startChunkIdx) {
                const relativeStart = startByte % CHUNK_SIZE;
                if (relativeStart > 0) buffer = buffer.slice(relativeStart);
            }
            // End Slice
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

            // D. Send to Client
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
