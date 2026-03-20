// Minimal static file server for self-hosting the browser-only redaction tool.
// No dependencies beyond Node.js built-ins.
// Usage: node serve.js [port]

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = parseInt(process.argv[2] || '3737', 10);
const PUBLIC = join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

createServer(async (req, res) => {
  // No restrictive COEP/COOP — they break CDN imports and aren't needed for WebGPU

  // Strip query string for file path resolution
  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
  let filePath = join(PUBLIC, pathname === '/' ? 'index.html' : pathname);

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Redaction tool (browser-only) at http://localhost:${PORT}`);
});
