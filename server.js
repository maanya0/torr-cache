const express = require('express');
const got = require('got');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const app = express();

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const CHUNK_SIZE = 20 * 1024 * 1024; 
const TIMEOUT_MS = 30000; 
const PUBLIC_URL = process.env.PUBLIC_URL || null;

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

// --- Endpoint 1: The Cache Unit (Cloudflare sees this) ---
app.get('/chunk', async (req, res) => {
    const { url, idx } = req.query;
    if (!url || idx === undefined) return res.status(400).send('Missing args');

    const chunkIndex = parseInt(idx, 10);
    const start = chunkIndex * CHUNK_SIZE;
    const end = start + CHUNK_SIZE - 1;

    try {
        // Create cache key and set headers IMMEDIATELY
        const cacheKey = getHash(url);
        const chunkHash = `${cacheKey}-${chunkIndex}`;
        
        // CRITICAL FIX: Set headers BEFORE making upstream request
        // Cloudflare decides cache status based on initial headers
        const headers = {
            'Content-Type': 'video/x-matroska', // Default, will update if needed
            'Cache-Control': 'public, max-age=31536000, immutable, s-maxage=31536000',
            'ETag': `"${chunkHash}"`,
            'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'none', // Important: Tell Cloudflare this is NOT a partial response
            'X-Cache-Key': chunkHash,
            'Vary': 'Accept-Encoding'
        };
        
        // FORCE 200 OK - Cloudflare only caches 200 responses
        res.writeHead(200, headers);

        const stream = got.stream(url, {
            headers: { 
                'Range': `bytes=${start}-${end}`,
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: { request: TIMEOUT_MS },
            retry: { limit: 2, methods: ['GET'] },
            agent: { http: httpAgent, https: httpsAgent },
            isStream: true
        });

        stream.on('response', (originRes) => {
            // Forward errors immediately
            if (originRes.statusCode >= 400) {
                // If headers already sent, just end the stream
                if (res.headersSent) {
                    stream.destroy();
                    res.end();
                } else {
                    res.status(originRes.statusCode).end();
                    stream.destroy();
                }
                return;
            }

            // Update content type if available from origin
            if (originRes.headers['content-type']) {
                res.setHeader('Content-Type', originRes.headers['content-type']);
            }
            
            // Set actual content length from origin
            const contentLength = originRes.headers['content-length'] || (end - start + 1);
            res.setHeader('Content-Length', contentLength);
            
            // CRITICAL: Remove any range-related headers that might leak through
            // Cloudflare will NOT cache if it sees Content-Range
            res.removeHeader('Content-Range');
            res.removeHeader('Accept-Ranges');
            
            // Additional Cloudflare optimization headers
            res.setHeader('CDN-Cache-Control', 'public, max-age=31536000');
            res.setHeader('Edge-Cache-Tag', `chunk-${chunkHash}`);
        });
        
        stream.on('error', (err) => { 
            console.error(`Stream error chunk ${chunkIndex}: ${err.message}`);
            // Only send error if headers haven't been sent yet
            if (!res.headersSent) res.status(502).end(); 
            else res.end(); // If headers sent, just end gracefully
        });

        // Pipe the stream - any upstream 206 is now converted to our 200
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
    // Add hash to URL for better cache consistency
    const fileHash = getHash(originUrl);
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
        const fileETag = `"${fileHash}"`;
        const lastModified = "Mon, 01 Jan 2024 00:00:00 GMT";

        // Set CORS headers first
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, ETag');
        
        res.setHeader('ETag', fileETag);
        res.setHeader('Last-Modified', lastModified);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-cache, no-store'); // Don't cache the stitcher

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
            try { 
                response = await nextChunkPromise; 
            } catch (e) { 
                console.error(`Fetch error chunk ${currentIdx}: ${e.message}`); 
                break; 
            }

            // B. Prefetch Next Chunk (Background)
            const nextIdx = currentIdx + 1;
            const nextStart = nextIdx * CHUNK_SIZE;
            const isLast = (totalSize && nextStart >= totalSize) || (endByte !== null && nextStart > endByte);
            
            // Limit prefetching to valid range and sane number of chunks
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
            
            // If chunk is smaller than expected, we've reached the end
            if (response.body.length < CHUNK_SIZE) needsToStop = true;

            // D. Send to Client
            const keepGoing = res.write(buffer);
            if (!keepGoing) await new Promise(r => res.once('drain', r));

            currentIdx++;
            // Safety limit
            if (currentIdx > 20000) needsToStop = true;
        }

        res.end();

    } catch (err) {
        console.error(`Media endpoint error: ${err.message}`);
        if (!res.headersSent) res.status(500).end();
    }
});

// Add health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        chunkSize: `${CHUNK_SIZE / 1024 / 1024}MB`
    });
});

// Add cache debug endpoint
app.get('/debug-cache', async (req, res) => {
    const { url, idx } = req.query;
    if (!url || idx === undefined) {
        return res.status(400).json({ error: 'Missing url or idx' });
    }
    
    const testUrl = `${PUBLIC_URL || `http://localhost:${PORT}`}/chunk?url=${encodeURIComponent(url)}&idx=${idx}`;
    
    try {
        const response = await got(testUrl, {
            headers: { 'User-Agent': 'Cache-Debug/1.0' },
            timeout: 10000
        });
        
        res.json({
            url: testUrl,
            status: response.statusCode,
            headers: response.headers,
            cacheStatus: response.headers['cf-cache-status'] || 'unknown',
            cacheControl: response.headers['cache-control'],
            hasContentRange: !!response.headers['content-range']
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Cloudflare Cache Proxy running on port ${PORT}`);
    console.log(`📦 Chunk size: ${CHUNK_SIZE / 1024 / 1024}MB`);
    console.log(`🌐 Public URL: ${PUBLIC_URL || 'Not set (caching disabled)'}`);
    if (!PUBLIC_URL) {
        console.log('⚠️  WARNING: PUBLIC_URL not set. Cloudflare caching will NOT work.');
        console.log('   Set PUBLIC_URL to your Cloudflare domain (e.g., https://stream.yourdomain.com)');
    }
});
