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
const TIMEOUT_MS = 30000; 

// IMPORTANT: 
// 1. For Testing: Leave this empty/unset. It will use localhost (fast, reliable).
// 2. For Cloudflare Caching: Set this to 'https://mc-cf.vb4nua.easypanel.host'
//    (Only set this once you confirm the stream works without it!)
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

    // Log chunk requests to see if they are actually hitting the server
    // console.log(`Fetching chunk ${chunkIndex} for ${url.slice(-20)}`);

    try {
        const stream = got.stream(url, {
            headers: { 'Range': `bytes=${start}-${end}` },
            timeout: { request: TIMEOUT_MS },
            retry: { limit: 2 },
            agent: { http: httpAgent, https: httpsAgent },
            isStream: true
        });

        stream.on('response', (originRes) => {
            if (originRes.statusCode >= 400) {
                console.error(`Origin Error ${originRes.statusCode} for chunk ${chunkIndex}`);
                res.status(originRes.statusCode).send('Origin Error');
                stream.destroy(); 
                return;
            }

            res.setHeader('Content-Type', originRes.headers['content-type'] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('ETag', `"${getFileHash(url)}-${chunkIndex}"`);
            res.status(200);
        });

        stream.on('error', (err) => {
            console.error(`Stream error for chunk ${chunkIndex}:`, err.message);
            if (!res.headersSent) res.status(502).send('Bad Gateway');
        });

        await pipeline(stream, res).catch(() => {});

    } catch (err) {
        console.error(`Setup error for chunk ${chunkIndex}:`, err.message);
        if (!res.headersSent) res.status(500).send('Internal Server Error');
    }
});

// --- Endpoint 2: Media Stitcher ---
app.get('/media', async (req, res) => {
    const originUrl = req.query.url;
    if (!originUrl) return res.status(400).send('Missing url');

    // FIX: Default to Localhost (HTTP) if PUBLIC_URL is missing.
    // This fixes the "1 byte" error caused by SSL/Loopback failures inside containers.
    const selfHost = PUBLIC_URL || `http://127.0.0.1:${PORT}`;

    console.log(`[Media Start] Using internal host: ${selfHost}`);

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
    res.setHeader('Content-Type', 'video/x-matroska');
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
                const response = await got(chunkUrl, { 
                    responseType: 'buffer',
                    timeout: { request: TIMEOUT_MS },
                    // Important: If you DO set PUBLIC_URL to https, we might need to ignore SSL errors internally
                    https: { rejectUnauthorized: false }, 
                    agent: { http: httpAgent, https: httpsAgent }
                });

                let buffer = response.body;

                if (currentChunkIdx === startChunkIdx) {
                    const relativeStart = startByte % CHUNK_SIZE;
                    if (relativeStart > 0) buffer = buffer.slice(relativeStart);
                }

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
                
                if (response.body.length < CHUNK_SIZE) needsToStop = true;
                if (currentChunkIdx > 20000) needsToStop = true; 

            } catch (err) {
                // THIS IS THE ERROR causing your 1-byte file. Check your logs!
                console.error(`[CRITICAL] Error fetching internal chunk ${currentChunkIdx} from ${chunkUrl}:`);
                console.error(err.message);
                if (err.response) console.error(`Status code: ${err.response.statusCode}`);
                
                // Stop the loop so we don't spam errors
                needsToStop = true;
            }
        }
        res.end();
    } catch (err) {
        console.error('Top level media error:', err);
        if (!res.headersSent) res.end();
    }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));


