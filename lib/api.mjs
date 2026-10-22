// The admin portal's API, shared by the local dev server (tools/server.mjs)
// and the Netlify Function (netlify/functions/api.mjs). Requests in, JSON out;
// nothing here knows which one is calling.
//
//   GET  /api/status            publishing mode, branch, current commit
//   POST /api/login             { email, password } → { token, name }
//   GET  /api/content[?sha=…]   site content, now or at an earlier commit
//   POST /api/publish           { content, files:[{path,data(base64)}], message } → { sha }
//   GET  /api/history           recent content commits
//   POST /api/restore           { sha } → commits that version back as the current one
//   GET  /api/stats?days=7|30   visitor numbers from Umami, or { configured: false }
//
// Everything except status and login needs `authorization: Bearer <token>`.
import crypto from 'node:crypto';
import { localBackend, githubBackend, validateContent, checkUploads } from './publish.mjs';
import { trafficStats } from './stats.mjs';

export function makeBackend(env, root) {
  if (env.GITHUB_TOKEN) return githubBackend({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO, branch: env.GITHUB_BRANCH || 'main' });
  if (root) return localBackend(root);
  return null; // deployed without GitHub settings: publishing is switched off
}

// Sessions are signed tokens rather than server memory, so they survive
// serverless functions starting cold. They last 12 hours.
const secretOf = (env) => env.SESSION_SECRET || crypto.createHash('sha256').update(`mugi:${env.ADMIN_PASSWORD || ''}:${env.GITHUB_TOKEN || 'local'}`).digest('hex');
const b64 = (s) => Buffer.from(s).toString('base64url');
function signToken(user, env) {
  const body = b64(JSON.stringify({ ...user, exp: Date.now() + 12 * 3600e3 }));
  return `${body}.${crypto.createHmac('sha256', secretOf(env)).update(body).digest('base64url')}`;
}
function readToken(token, env) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secretOf(env)).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const user = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return user.exp > Date.now() ? user : null;
}
const samePassword = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function handleApi({ method, path, query = {}, body = {}, auth = '' }, { backend, env }) {
  const route = `${method} ${path}`;
  if (route === 'GET /api/status') {
    if (!backend) return [200, { mode: 'off', passwordRequired: !!env.ADMIN_PASSWORD }];
    return [200, { ...(await backend.status()), passwordRequired: !!env.ADMIN_PASSWORD }];
  }
  if (route === 'POST /api/login') {
    const { email = '', password = '' } = body;
    // A deployed site must have a password; locally it is optional.
    if (env.ADMIN_PASSWORD ? !samePassword(String(password), env.ADMIN_PASSWORD) : env.NETLIFY) return [401, { error: 'Wrong email or password.' }];
    const user = { name: String(email).split('@')[0] || 'admin', email: String(email) || 'admin@mugi.vn' };
    return [200, { token: signToken(user, env), name: user.name }];
  }
  const user = readToken(auth.replace(/^Bearer /, ''), env);
  if (!user) return [401, { error: 'Please sign in again.' }];

  if (route === 'GET /api/stats') return [200, await trafficStats(env, Number(query.days) === 30 ? 30 : 7)];
  if (!backend) return [503, { error: 'Publishing is not set up: add GITHUB_TOKEN and GITHUB_REPO to the site’s environment variables.' }];
  if (route === 'GET /api/content') return [200, await backend.read(query.sha || undefined)];
  if (route === 'GET /api/history') return [200, await backend.history()];
  if (route === 'POST /api/publish') {
    const { content, files = [], message, authorName } = body;
    const errors = validateContent(content);
    if (errors.length) return [422, { error: 'The content has problems, nothing was published.', errors }];
    checkUploads(files);
    const msg = String(message || 'Update website content').slice(0, 200);
    return [200, await backend.publish({ content, files, message: msg, author: { name: authorName || user.name, email: user.email } })];
  }
  if (route === 'POST /api/restore') {
    const { sha } = body;
    if (!/^[0-9a-f]{7,40}$/.test(sha || '')) return [400, { error: 'Unknown version.' }];
    // Website text, photos and menu come back; news and jobs stay as they are now.
    const [content, current] = await Promise.all([backend.read(sha), backend.read()]);
    content.news = current.news; content.jobs = current.jobs;
    return [200, await backend.publish({ content, message: `Restore website content from ${sha}`, author: user })];
  }
  return [404, { error: 'Not found' }];
}
