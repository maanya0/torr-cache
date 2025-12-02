const express = require('express');
const got = require('got');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');

const app = express();

// --- Configuration ---
const PORT = process.env.PORT || 8080; // Matching your deployed port
const CHUNK_SIZE = 20 * 1024 * 1024; // 20 MiB
const TIMEOUT_MS = 30000; 

// IMPORTANT: Set this to your Cloudflare domain (e.g. https://stream.hyper154.pw)
// If not set, it defaults to localhost (which bypasses Cloudflare cache for internal fetches)
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

// --- Endpoint 2: Media Stitcher (Now with Size Support) ---
app.get('/media', async (req, res) => {
    const originUrl = req.query.url;
    if (!originUrl) return res.status(400).send('Missing url');

    // Default to Localhost if PUBLIC_URL is missing to ensure internal fetching works
    const selfHost = PUBLIC_URL || `http://127.0.0.1:${PORT}`;

    try {
        // STEP 1: Get File Metadata (Total Size)
        // We MUST know the size to support seeking/resuming
        const headResponse = await got.head(originUrl, {
            timeout: { request: 5000 },
            agent: { http: httpAgent, https: httpsAgent },
            retry: { limit: 1 }
        });

        const totalSize = parseInt(headResponse.headers['content-length'], 10);
        if (isNaN(totalSize)) {
            console.warn('Origin did not return content-length');
        }

        // STEP 2: Parse Range Header from Client
        const rangeHeader = req.headers.range || 'bytes=0-';
        const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        
        let startByte = 0;
        let endByte = totalSize ? totalSize - 1 : null; // Default to full file if known
        
        if (rangeMatch) {
            startByte = parseInt(rangeMatch[1], 10);
            if (rangeMatch[2]) {
                endByte = parseInt(rangeMatch[2], 10);
            }
        }

        // Sanity check: if client asks for range beyond file size
        if (totalSize && startByte >= totalSize) {
            res.setHeader('Content-Range', `bytes */${totalSize}`);
            return res.status(416).send('Requested Range Not Satisfiable');
        }

        // STEP 3: Send Response Headers
        res.status(206); // Partial Content
        res.setHeader('Content-Type', headResponse.headers['content-type'] || 'video/x-matroska');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-cache'); // Don't cache the stitcher, only the chunks
        
        // Correct Content-Length is vital for progress bars
        if (endByte !== null) {
            res.setHeader('Content-Length', endByte - startByte + 1);
            res.setHeader('Content-Range', `bytes ${startByte}-${endByte}/${totalSize || '*'}`);
        } else {
             // Fallback if size is truly unknown (rare)
             res.setHeader('Content-Range', `bytes ${startByte}-/*`);
        }

        // STEP 4: Streaming Loop
        const startChunkIdx = Math.floor(startByte / CHUNK_SIZE);
        let currentChunkIdx = startChunkIdx;
        let needsToStop = false;

        while (!needsToStop) {
            const chunkUrl = `${selfHost}/chunk?url=${encodeURIComponent(originUrl)}&idx=${currentChunkIdx}`;

            try {
                // Buffer 10MB chunk for processing
                const response = await got(chunkUrl, { 
                    responseType: 'buffer',
                    timeout: { request: TIMEOUT_MS },
                    https: { rejectUnauthorized: false }, // Ignore SSL errors for internal localhost
                    agent: { http: httpAgent, https: httpsAgent }
                });

                let buffer = response.body;

                // Slice Start (if inside the first requested chunk)
                if (currentChunkIdx === startChunkIdx) {
                    const relativeStart = startByte % CHUNK_SIZE;
                    if (relativeStart > 0) buffer = buffer.slice(relativeStart);
                }

                // Slice End (if we reached the end of the requested range)
                if (endByte !== null) {
                    const chunkStartPos = currentChunkIdx * CHUNK_SIZE;
                    // Position of the buffer's start in the real file
                    const bufferAbsStart = chunkStartPos + (currentChunkIdx === startChunkIdx ? (startByte % CHUNK_SIZE) : 0);
                    const bytesNeeded = (endByte + 1) - bufferAbsStart;
                    
                    if (buffer.length > bytesNeeded) {
                        buffer = buffer.slice(0, bytesNeeded);
                        needsToStop = true; // We found the end
                    }
                }

                const keepGoing = res.write(buffer);
                if (!keepGoing) await new Promise(resolve => res.once('drain', resolve));

                currentChunkIdx++;
                
                // End loop conditions
                if (response.body.length < CHUNK_SIZE) needsToStop = true; // EOF from origin
                if (totalSize && (currentChunkIdx * CHUNK_SIZE > endByte)) needsToStop = true; // EOF from calc
                if (currentChunkIdx > 20000) needsToStop = true; // Safety

            } catch (err) {
                console.error(`Error fetching chunk ${currentChunkIdx}: ${err.message}`);
                needsToStop = true;
            }
        }
        res.end();

    } catch (err) {
        console.error('Metadata fetch error:', err.message);
        if (!res.headersSent) res.status(502).send('Could not fetch file metadata');
    }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));


