const express = require('express');
const got = require('got');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');

const app = express();

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MiB
const TIMEOUT_MS = 30000; // Increased to 30s for TorrServer buffering

// IMPORTANT: Set this to your Cloudflare domain (e.g., 'https://video.site.com')
const PUBLIC_URL = process.env.PUBLIC_URL || null;

// --- Connection Pooling ---
const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 100
};
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

function getFileHash(url) {
    return crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
}

// --- Endpoint 1: Single Chunk ---
app.get('/chunk', async (req, res) => {
    const { url, idx } = req.query;

    if (!url || idx === undefined) return res.status(400).send('Missing url or idx');

    const chunkIndex = parseInt(idx, 10);
    const start = chunkIndex * CHUNK_SIZE;
    const end = start + CHUNK_SIZE - 1;

    try {
        // Torrserver accepts Range headers perfectly
        const stream = got.stream(url, {
            headers: { 'Range': `bytes=${start}-${end}` },
            timeout: { request: TIMEOUT_MS },
            retry: { limit: 2 },
            agent: { http: httpAgent, https: httpsAgent },
            isStream: true
        });

        stream.on('response', (originRes) => {
            if (originRes.statusCode >= 400) {
                res.status(originRes.statusCode).send('Origin Error');
                stream.destroy(); 
                return;
            }

            res.setHeader('Content-Type', originRes.headers['content-type'] || 'application/octet-stream');
            
            // Cloudflare Caching Headers
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('ETag', `"${getFileHash(url)}-${chunkIndex}"`);
            res.status(200);
        });

        stream.on('error', (err) => {
            if (!res.headersSent) res.status(502).send('Bad Gateway');
        });

        await pipeline(stream, res).catch(() => {});

    } catch (err) {
        if (!res.headersSent) res.status(500).send('Internal Server Error');
    }
});

// --- Endpoint 2: Media Stitcher ---
app.get('/media', async (req, res) => {
    const originUrl = req.query.url;
    if (!originUrl) return res.status(400).send('Missing url');

    const selfHost = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const rangeHeader = req.headers.range || 'bytes=0-';
    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    
    let startByte = 0;
    let endByte = null; 
    
    if (rangeMatch) {
        startByte = parseInt(rangeMatch[1], 10);
        if (rangeMatch[2]) endByte = parseInt(rangeMatch[2], 10);
    }

    const startChunkIdx = Math.floor(startByte / CHUNK_SIZE);
    
    res.status(206);
    res.setHeader('Content-Type', 'video/x-matroska'); // Torrserver usually sends MKV
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache'); 

    if (endByte !== null) {
        res.setHeader('Content-Length', endByte - startByte + 1);
        res.setHeader('Content-Range', `bytes ${startByte}-${endByte}/*`);
    } else {
        res.setHeader('Content-Range', `bytes ${startByte}-/*`);
    }

    try {
        let currentChunkIdx = startChunkIdx;
        let needsToStop = false;

        while (!needsToStop) {
            const chunkUrl = `${selfHost}/chunk?url=${encodeURIComponent(originUrl)}&idx=${currentChunkIdx}`;

            try {
                // Buffer the chunk in memory (10MB) for precise slicing
                const response = await got(chunkUrl, { 
                    responseType: 'buffer',
                    timeout: { request: TIMEOUT_MS },
                    agent: { http: httpAgent, https: httpsAgent }
                });

                let buffer = response.body;

                // 1. Slice Start
                if (currentChunkIdx === startChunkIdx) {
                    const relativeStart = startByte % CHUNK_SIZE;
                    if (relativeStart > 0) buffer = buffer.slice(relativeStart);
                }

                // 2. Slice End
                if (endByte !== null) {
                    const chunkStartPos = currentChunkIdx * CHUNK_SIZE;
                    const absoluteBufferStart = chunkStartPos + (currentChunkIdx === startChunkIdx ? (startByte % CHUNK_SIZE) : 0);
                    const bytesRemainingRequest = (endByte + 1) - absoluteBufferStart;
                    
                    if (buffer.length > bytesRemainingRequest) {
                        buffer = buffer.slice(0, bytesRemainingRequest);
                        needsToStop = true;
                    }
                }

                const keepGoing = res.write(buffer);
                if (!keepGoing) await new Promise(resolve => res.once('drain', resolve));

                currentChunkIdx++;
                
                // Stop if we hit EOF (chunk smaller than 10MB)
                if (response.body.length < CHUNK_SIZE) needsToStop = true;
                
                // UPDATED LIMIT: 20,000 chunks = ~200GB file size limit
                if (currentChunkIdx > 20000) needsToStop = true; 

            } catch (err) {
                console.error(`Error fetching chunk ${currentChunkIdx}: ${err.message}`);
                needsToStop = true;
            }
        }
        res.end();
    } catch (err) {
        if (!res.headersSent) res.end();
    }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));


