// Local stand-in for the admin's Netlify deploy: serves the portal, the public
// site under /site/ (as the Netlify proxy does), and the API. No dependencies:
//
//   node tools/server.mjs                      → http://localhost:4321
//       site files and git commits come from ../mugi_landing
//   SITE_DIR=/path/to/site node tools/server.mjs     another site checkout
//   ADMIN_PASSWORD=… node tools/server.mjs           require a password
//   GITHUB_TOKEN=… GITHUB_REPO=owner/name node tools/server.mjs   commit on GitHub
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, makeBackend } from '../lib/api.mjs';
import { makeDb } from '../lib/db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Settings such as SUPABASE_URL can live in .env (gitignored).
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const SITE = path.resolve(ROOT, process.env.SITE_DIR || '../mugi_landing');
const PORT = Number(process.env.PORT) || 4321;
const env = process.env;
const backend = makeBackend(env, SITE);
// Without SUPABASE_URL, bookings and settings are kept in data/ (gitignored).
const db = makeDb(env, path.join(ROOT, 'data'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };

const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, fail) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > 40 * 1024 * 1024) { fail(new Error('request too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { fail(new Error('invalid JSON')); } });
});

async function file(res, base, p) {
  if (p.endsWith('/')) p += 'index.html';
  const abs = path.join(base, p);
  if (!abs.startsWith(base + path.sep) || /(^|\/)\.(git|env)/.test(p)) { res.writeHead(404); return res.end(); }
  try {
    const data = await fs.readFile(abs);
    res.writeHead(200, { 'content-type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    // /site/api/* is the website's own /api/* (its Netlify proxy to this API)
    if (p.startsWith('/api/') || p.startsWith('/site/api/')) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const [status, json] = await handleApi({ method: req.method, path: p.replace(/^\/site/, ''), query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization || '', ip: req.socket.remoteAddress }, { backend, db, env });
      send(res, status, json);
    } else if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); }
    else if (p === '/site') { res.writeHead(301, { location: '/site/' }); res.end(); }
    else if (p.startsWith('/site/')) await file(res, SITE, p.slice(5));
    else if (/^\/(tools|lib|netlify|data|db)\//.test(p)) { res.writeHead(404); res.end(); }
    else await file(res, ROOT, p);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`MUGI admin  http://localhost:${PORT}/\nSite        http://localhost:${PORT}/site/  (from ${SITE})\nPublishing  ${backend.mode}\nBookings    ${db.mode}`));
