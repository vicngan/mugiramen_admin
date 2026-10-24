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
//   GET  /api/reservations?from=&to=   bookings between two dates (YYYY-MM-DD)
//   POST /api/reservations/status      { id, status } → the updated booking
//   GET  /api/settings                 booking rules and branch contacts
//   POST /api/settings                 { booking?, notify? } → saved settings
//
// Public, for the website's reservation form (reached through the site's own
// /api/* proxy, so there's no cross-origin request):
//   GET  /api/booking-rules     bookable days, times and party size
//   POST /api/reservations      { name, phone, branch, datetime, party_size, confirm_by, lang, note? }
//
// Everything else needs `authorization: Bearer <token>`.
import crypto from 'node:crypto';
import { localBackend, githubBackend, validateContent, checkUploads } from './publish.mjs';
import { trafficStats } from './stats.mjs';
import { loadSettings, cleanSettings, publicRules, checkBooking, ipHash, notifyBranch, BRANCHES } from './reservations.mjs';
import { report } from './monitor.mjs';

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

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const noDb = [503, { error: 'Reservations are not set up: add SUPABASE_URL and SUPABASE_SECRET_KEY to the site’s environment variables.' }];

export async function handleApi({ method, path, query = {}, body = {}, auth = '', ip = '' }, { backend, db, env }) {
  const route = `${method} ${path}`;
  if (route === 'GET /api/status') {
    const extra = { passwordRequired: !!env.ADMIN_PASSWORD, db: db ? db.mode : 'off' };
    if (!backend) return [200, { mode: 'off', ...extra }];
    return [200, { ...(await backend.status()), ...extra }];
  }
  if (route === 'GET /api/booking-rules') return [200, publicRules(await loadSettings(db))];
  if (route === 'POST /api/reservations') {
    if (!db) return noDb;
    // The form's hidden decoy field: bots fill it in, people never see it.
    if (body.website) return [200, { ok: true }];
    const hash = ipHash(ip || 'unknown', secretOf(env));
    if (await db.recentFrom(hash, new Date(Date.now() - 10 * 60e3).toISOString()) >= 5) return [429, { error: 'rate', code: 'rate' }];
    const settings = await loadSettings(db);
    const { booking, error, field } = checkBooking(body, settings);
    if (error) return [422, { error, code: error, field, rules: publicRules(settings) }];
    const row = await db.addReservation({ ...booking, ip_hash: hash });
    const n = await notifyBranch(env, settings, row);
    await db.updateReservation(row.id, n.sent ? { notified_at: new Date().toISOString() } : { notify_error: n.error });
    // The guest is booked either way, but the branch doesn't know: staff must check the portal.
    if (!n.sent) await report(env, 'error', 'booking', `Booking #${row.id} at ${BRANCHES[row.branch] || row.branch} was saved, but the branch wasn't emailed: ${n.error}`, { ref: { id: String(row.id), label: `Booking #${row.id}` }, key: 'booking-email', cooldownMin: 60 });
    return [200, { ok: true, id: row.id, branch: row.branch, date: row.date, time: row.time, party_size: row.party_size }];
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
  if (route === 'GET /api/reservations') {
    if (!db) return noDb;
    if (!DAY_RE.test(query.from || '') || !DAY_RE.test(query.to || '') || query.from > query.to) return [400, { error: 'from and to must be dates' }];
    return [200, await db.listReservations({ from: query.from, to: query.to })];
  }
  if (route === 'POST /api/reservations/status') {
    if (!db) return noDb;
    if (!['new', 'confirmed', 'cancelled', 'noshow'].includes(body.status)) return [400, { error: 'Unknown status.' }];
    const row = await db.updateReservation(body.id, { status: body.status, updated_at: new Date().toISOString(), updated_by: user.name });
    return row ? [200, row] : [404, { error: 'Booking not found.' }];
  }
  if (route === 'GET /api/settings') return [200, await loadSettings(db)];
  if (route === 'POST /api/settings') {
    if (!db) return noDb;
    const { out, errs } = cleanSettings(body);
    if (errs.length) return [422, { error: 'Some settings are not valid.', errors: errs }];
    await db.saveSettings(out, user.name);
    return [200, await loadSettings(db)];
  }
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
