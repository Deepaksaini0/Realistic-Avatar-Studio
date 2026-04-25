/**
 * server.js — Express server for Realistic Avatar Studio
 *
 * Does two things:
 *  1. Serves the static HTML/JS/CSS from this directory.
 *  2. Exposes /api/proxy that forwards requests to the D-ID API
 *     using the DID_API_KEY environment variable (or X-Did-Key header).
 *
 * Designed for Render.com (free tier works) but runs anywhere Node 18+ runs.
 *   npm install
 *   DID_API_KEY=your_key npm start
 */

const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const D_ID_BASE = 'https://api.d-id.com';

/* ---------- Static files (HTML / CSS / JS) ---------- */
app.use(express.static(__dirname, { index: 'realistic-avatar.html' }));

/* ---------- CORS (same-origin in prod, but harmless) ---------- */
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Did-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---------- Multer for image uploads (in memory) ---------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

/* ---------- Helpers ---------- */
function getApiKey(req) {
  return (req.headers['x-did-key'] || process.env.DID_API_KEY || '').trim();
}
function authHeader(key) {
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

/* ---------- Choose body parser based on content-type ---------- */
function conditionalParser(req, res, next) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('multipart/form-data')) {
    return upload.single('image')(req, res, next);
  }
  return express.json({ limit: '5mb' })(req, res, next);
}

/* ---------- The proxy endpoint ---------- */
app.all('/proxy', conditionalParser, async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return res.status(401).json({
      error: 'Missing API key. Set DID_API_KEY env var on Render, or send X-Did-Key header from the browser.',
    });
  }

  const proxyPath = (req.query.path || '').toString();
  if (!proxyPath || !/^[A-Za-z0-9/_\-\.]+$/.test(proxyPath)) {
    return res.status(400).json({ error: 'Invalid or missing ?path parameter.' });
  }

  const url = `${D_ID_BASE}/${proxyPath}`;
  const headers = {
    Authorization: authHeader(apiKey),
    Accept: 'application/json',
  };

  let body;
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    if (req.file) {
      // Multipart upload (image)
      const fd = new FormData();
      fd.append('image', req.file.buffer, {
        filename: req.file.originalname || 'photo.jpg',
        contentType: req.file.mimetype || 'image/jpeg',
      });
      Object.assign(headers, fd.getHeaders());
      body = fd;
    } else {
      // JSON
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body || {});
    }
  }

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body,
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    console.error('Upstream error:', err);
    res.status(502).json({ error: 'Upstream request failed', detail: err.message });
  }
});

/* ---------- Result-video proxy (D-ID's S3 has no CORS) ---------- */
// Strict whitelist: only D-ID's own S3 buckets. Prevents open-proxy abuse.
const ALLOWED_DOWNLOAD = /^https:\/\/d-id[a-z0-9.\-_]*\.s3[.\-][a-z0-9\-]+\.amazonaws\.com\//i;

app.get('/api/fetch', async (req, res) => {
  const url = (req.query.url || '').toString();
  if (!url) return res.status(400).send('Missing url parameter');
  if (!ALLOWED_DOWNLOAD.test(url)) return res.status(403).send('URL not in whitelist');

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(upstream.status).send('Upstream failed');
    res.set('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    const len = upstream.headers.get('content-length');
    if (len) res.set('Content-Length', len);
    res.set('Cache-Control', 'no-store');
    upstream.body.pipe(res);
  } catch (err) {
    console.error('Download proxy error:', err);
    res.status(502).send('Fetch failed: ' + err.message);
  }
});

/* ---------- Health check (Render hits / by default) ---------- */
app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Realistic Avatar Studio listening on http://localhost:${PORT}`);
});
