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
//   GET  /api/reservations?from=&to=   bookings between two dates (YYYY-MM-DD), each
//                                      with the guest's confirmation-link token
//   POST /api/reservations/status      { id, status, force? } → the updated booking; 409 { code: 'full' }
//                                      when it would need a table there isn't (force books anyway)
//   POST /api/reservations/add         { branch, date, time, party_size, name, phone?, note?, source, status?, force? }
//                                      a booking taken by phone or a walk-in → the booking, with its token
//   GET  /api/settings                 booking rules, branch contacts, sign-up switch
//   POST /api/settings                 { booking?, notify?, access? } → saved settings
//   GET  /api/me                       the signed-in person
//   POST /api/me                       { name } → updated person
//   POST /api/me/password              { current, next } → { token } (other sessions end)
//   GET  /api/staff                    everyone, with sign-up requests (owners)
//   POST /api/staff                    { id?, name, email, role, branch, perms, approve? } → { member, invite? }
//   POST /api/staff/link               { id } → { invite } a new set-password link
//   POST /api/staff/remove             { id } → removes access
//
// Staff accounts need the database. The first sign-in, while there's no
// owner yet, creates the owner account (with ADMIN_PASSWORD when it's set).
// Without a database, everyone signs in with the shared ADMIN_PASSWORD.
//
// Public, for the sign-in page:
//   GET  /api/setup             { needsOwner } whether the next sign-in creates the owner
//   GET  /api/invite?token=     { name, email } for a set-password link
//   POST /api/invite            { token, password } → { token, me }
//   POST /api/signup            { name, email, password, branch } → a request for an owner to approve
//
// Public, for the website's reservation form (reached through the site's own
// /api/* proxy, so there's no cross-origin request):
//   GET  /api/booking-rules     bookable days, times and party size
//   GET  /api/availability?branch=&date=&party=   { full: ['18:00', …] } times with no table left
//   POST /api/reservations      { name, phone, branch, datetime, party_size, confirm_by, lang, note?, waitlist? }
//                               → 409 { code: 'full', suggest } when the time has no table left,
//                                 unless waitlist is set: then it joins that time's waiting list
//   GET  /api/my-booking?token=          the booking behind a guest's confirmation link
//   POST /api/my-booking         { token, action: 'confirm' | 'cancel' } → that booking
//
// Everything else needs `authorization: Bearer <token>`.
import crypto from 'node:crypto';
import { localBackend, githubBackend, validateContent, checkUploads } from './publish.mjs';
import { trafficStats } from './stats.mjs';
import { loadSettings, cleanSettings, publicRules, checkBooking, checkStaffBooking, ipHash, notifyBranch, BRANCHES, HOLDS, branchId, fits, fullTimes, nearestFree } from './reservations.mjs';
import { report } from './monitor.mjs';
import { hashPassword, checkPassword, passwordProblem, newInvite, hashToken, publicStaff, can, branchScope, cleanMember, signIn, ROLE_PERMS, STAFF_BRANCHES } from './staff.mjs';

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

// With accounts, the token only names the person and their sign-in version;
// who they are and what they may do is read fresh on every request, so a
// removed person or changed access takes effect at once.
async function currentUser(token, env, db) {
  const t = readToken(token, env);
  if (!t) return null;
  if (!db) return { ...t, role: 'owner', branch: 'all', perms: { ...ROLE_PERMS.owner } };
  if (!t.id) return null;
  const row = await db.findStaff('id', t.id);
  return row && row.status === 'active' && row.token_version === t.v ? row : null;
}
const session = (row, env) => ({ token: signToken({ id: row.id, v: row.token_version }, env), me: publicStaff(row) });
const owners = (all) => all.filter((r) => r.role === 'owner' && r.status === 'active');
const forbidden = [403, { error: 'You don’t have access to this.' }];
// Which permission each part of the site's content needs to change.
const PART_PERM = { news: 'news', jobs: 'careers' };
function partsChanged(next, current) {
  const keys = new Set([...Object.keys(next || {}), ...Object.keys(current || {})]);
  return [...keys].filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k])).map((k) => PART_PERM[k] || 'site');
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// The guest's link to confirm or cancel a booking: its id, signed, so nothing
// extra is stored and staff can send the same link again.
const confirmToken = (id, env) => `${id}.${crypto.createHmac('sha256', secretOf(env)).update('confirm:' + id).digest('base64url').slice(0, 24)}`;
const tokenId = (token, env) => {
  const id = Number(String(token || '').split('.')[0]);
  if (!Number.isInteger(id) || id < 1) return null;
  const want = Buffer.from(confirmToken(id, env)), got = Buffer.from(String(token));
  return got.length === want.length && crypto.timingSafeEqual(got, want) ? id : null;
};
const guestView = (r) => ({ branch: r.branch, date: r.date, time: r.time, party_size: r.party_size, name: r.name, status: r.status, lang: r.lang });
const fullError = [409, { error: 'There’s no table left at that time.', code: 'full' }];
const noDb = [503, { error: 'Reservations are not set up: add SUPABASE_URL and SUPABASE_SECRET_KEY to the site’s environment variables.' }];

export async function handleApi({ method, path, query = {}, body = {}, auth = '', ip = '' }, { backend, db, env }) {
  const route = `${method} ${path}`;
  if (route === 'GET /api/status') {
    const extra = { passwordRequired: !!env.ADMIN_PASSWORD, db: db ? db.mode : 'off' };
    if (!backend) return [200, { mode: 'off', ...extra }];
    return [200, { ...(await backend.status()), ...extra }];
  }
  if (route === 'GET /api/booking-rules') return [200, publicRules(await loadSettings(db))];
  if (route === 'GET /api/availability') {
    const branch = branchId(query.branch), party = Number(query.party) || 1;
    if (!db || !branch || !DAY_RE.test(query.date || '') || !Number.isInteger(party) || party < 1 || party > 100) return [200, { full: [] }];
    const settings = await loadSettings(db);
    return [200, { full: fullTimes(await db.listReservations({ from: query.date, to: query.date }), branch, party, settings.booking) }];
  }
  if (route === 'GET /api/my-booking' || route === 'POST /api/my-booking') {
    if (!db) return noDb;
    const id = tokenId(method === 'GET' ? query.token : body.token, env);
    const row = id && (await db.getReservation(id));
    if (!row) return [404, { error: 'This link isn’t valid.', code: 'notFound' }];
    if (method === 'GET') return [200, guestView(row)];
    const to = { confirm: 'confirmed', cancel: 'cancelled' }[body.action];
    if (!to) return [400, { error: 'Unknown action.' }];
    if (row.status === to) return [200, guestView(row)];
    // only an upcoming booking that is still on can be changed from the link
    const todayHanoi = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    const open = to === 'cancelled' ? ['new', 'confirmed', 'waitlist'] : ['new', 'confirmed'];
    if (!open.includes(row.status) || row.date < todayHanoi) return [409, { error: 'This booking can’t be changed any more.', code: 'closed', ...guestView(row) }];
    return [200, guestView(await db.updateReservation(id, { status: to, updated_at: new Date().toISOString(), updated_by: 'guest' }))];
  }
  if (route === 'POST /api/reservations') {
    if (!db) return noDb;
    // The form's hidden decoy field: bots fill it in, people never see it.
    if (body.website) return [200, { ok: true }];
    const hash = ipHash(ip || 'unknown', secretOf(env));
    if (await db.recentFrom(hash, new Date(Date.now() - 10 * 60e3).toISOString()) >= 5) return [429, { error: 'rate', code: 'rate' }];
    const settings = await loadSettings(db);
    const { booking, error, field } = checkBooking(body, settings);
    if (error) return [422, { error, code: error, field, rules: publicRules(settings) }];
    const sameDay = await db.listReservations({ from: booking.date, to: booking.date });
    if (fits(sameDay, booking.branch, booking.time, booking.party_size, settings.booking)) booking.status = 'new';
    else if (booking.status !== 'waitlist') {
      return [409, { error: 'full', code: 'full', field: 'datetime', suggest: nearestFree(sameDay, booking.branch, booking.date, booking.time, booking.party_size, settings.booking) }];
    }
    const row = await db.addReservation({ ...booking, ip_hash: hash });
    const n = await notifyBranch(env, settings, row);
    await db.updateReservation(row.id, n.sent ? { notified_at: new Date().toISOString() } : { notify_error: n.error });
    // The guest is booked either way, but the branch doesn't know: staff must check the portal.
    if (!n.sent) await report(env, 'error', 'booking', `Booking #${row.id} at ${BRANCHES[row.branch] || row.branch} was saved, but the branch wasn't emailed: ${n.error}`, { ref: { id: String(row.id), label: `Booking #${row.id}` }, key: 'booking-email', cooldownMin: 60 });
    return [200, { ok: true, id: row.id, branch: row.branch, date: row.date, time: row.time, party_size: row.party_size, status: row.status }];
  }
  // A deployed site must have a password; locally it is optional.
  const sharedPasswordOk = (pw) => (env.ADMIN_PASSWORD ? samePassword(String(pw), env.ADMIN_PASSWORD) : !env.NETLIFY);
  if (route === 'POST /api/login') {
    const { email = '', password = '' } = body;
    if (!db) {
      if (!sharedPasswordOk(password)) return [401, { error: 'Wrong email or password.' }];
      const user = { name: String(email).split('@')[0] || 'admin', email: String(email) || 'admin@mugi.vn' };
      return [200, { token: signToken(user, env), me: { ...user, role: 'owner', branch: 'all', perms: { ...ROLE_PERMS.owner } } }];
    }
    // No owner yet: this sign-in sets one up, with the shared password.
    if (!owners(await db.listStaff()).length) {
      const mail = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return [400, { error: 'Enter your email.' }];
      if (!sharedPasswordOk(password) || passwordProblem(password)) return [401, { error: 'Wrong email or password.' }];
      const existing = await db.findStaff('email', mail);
      const fields = { name: String(body.name || '').trim() || mail.split('@')[0], role: 'owner', branch: 'all', perms: { ...ROLE_PERMS.owner }, status: 'active', password_hash: await hashPassword(password), last_login: new Date().toISOString(), created_by: 'setup' };
      const row = existing ? await db.updateStaff(existing.id, fields) : await db.addStaff({ email: mail, ...fields });
      return [200, { ...session(row, env), firstOwner: true }];
    }
    const r = await signIn(db, email, password);
    return r.error ? [r.status, { error: r.error }] : [200, session(r.user, env)];
  }
  if (route === 'GET /api/setup') return [200, { accounts: !!db, needsOwner: !!db && !owners(await db.listStaff()).length }];
  if (route === 'GET /api/invite' || route === 'POST /api/invite') {
    if (!db) return noDb;
    const row = await db.findStaff('invite_hash', hashToken(query.token || body.token || ''));
    if (!row || row.status === 'disabled' || Date.parse(row.invite_expires) < Date.now()) return [404, { error: 'This link has expired or was already used. Ask the owner for a new one.' }];
    if (method === 'GET') return [200, { name: row.name, email: row.email }];
    const problem = passwordProblem(body.password);
    if (problem) return [422, { error: problem }];
    const done = await db.updateStaff(row.id, { password_hash: await hashPassword(body.password), status: 'active', invite_hash: null, invite_expires: null, token_version: row.token_version + 1, failed_logins: 0, locked_until: null, last_login: new Date().toISOString() });
    return [200, session(done, env)];
  }
  if (route === 'POST /api/signup') {
    if (!db) return noDb;
    if (body.website) return [200, { ok: true }];
    const settings = await loadSettings(db);
    if (!settings.access.allowSignup) return [403, { error: 'Sign-up is turned off. Ask the owner to add you.' }];
    const email = String(body.email || '').trim().toLowerCase(), name = String(body.name || '').trim();
    if (!name || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return [422, { error: 'Enter your name and email.' }];
    const problem = passwordProblem(body.password);
    if (problem) return [422, { error: problem }];
    if (await db.findStaff('email', email)) return [409, { error: 'That email already has an account or a request.' }];
    const branch = STAFF_BRANCHES.includes(body.branch) && body.branch !== 'all' ? body.branch : 'office';
    await db.addStaff({ email, name, branch, role: 'staff', perms: { ...ROLE_PERMS.staff }, status: 'pending', password_hash: await hashPassword(body.password), created_by: 'sign-up' });
    return [200, { ok: true }];
  }
  const user = await currentUser(auth.replace(/^Bearer /, ''), env, db);
  if (!user) return [401, { error: 'Please sign in again.' }];

  if (route === 'GET /api/me') return [200, db ? publicStaff(user) : { name: user.name, email: user.email, role: 'owner', branch: 'all', perms: user.perms }];
  if (route === 'POST /api/me') {
    if (!db) return noDb;
    const name = String(body.name || '').trim();
    if (!name || name.length > 80) return [422, { error: 'A name is needed.' }];
    return [200, publicStaff(await db.updateStaff(user.id, { name }))];
  }
  if (route === 'POST /api/me/password') {
    if (!db) return noDb;
    if (!(await checkPassword(body.current, user.password_hash))) return [403, { error: 'The current password isn’t right.' }];
    const problem = passwordProblem(body.next);
    if (problem) return [422, { error: problem }];
    const row = await db.updateStaff(user.id, { password_hash: await hashPassword(body.next), token_version: user.token_version + 1 });
    return [200, session(row, env)];
  }
  if (route.startsWith('GET /api/staff') || route.startsWith('POST /api/staff')) {
    if (!db) return noDb;
    if (!can(user, 'members')) return forbidden;
    const all = await db.listStaff();
    if (route === 'GET /api/staff') return [200, all.filter((r) => r.status !== 'disabled').map(publicStaff)];
    const target = body.id ? all.find((r) => r.id === body.id) : null;
    if (body.id && !target) return [404, { error: 'Not found.' }];
    const lastOwner = (r) => r.role === 'owner' && owners(all).length === 1 && owners(all)[0].id === r.id;
    if (route === 'POST /api/staff') {
      const { patch, error } = cleanMember(body, !target);
      if (error) return [422, { error }];
      if (target && lastOwner(target) && patch.role !== 'owner') return [422, { error: 'There must always be at least one owner.' }];
      if (!target) {
        if (all.some((r) => r.email === patch.email && r.status !== 'disabled')) return [409, { error: 'That email already has an account.' }];
        const inv = newInvite();
        const old = all.find((r) => r.email === patch.email); // someone removed earlier, invited again
        const fields = { ...patch, status: 'invited', password_hash: null, invite_hash: inv.hash, invite_expires: inv.expires, created_by: user.name };
        const row = old ? await db.updateStaff(old.id, { ...fields, token_version: old.token_version + 1 }) : await db.addStaff(fields);
        return [200, { member: publicStaff(row), invite: inv.token }];
      }
      // approving a sign-up request keeps the password they chose
      const extra = target.status === 'pending' && body.approve ? { status: 'active' } : {};
      return [200, { member: publicStaff(await db.updateStaff(target.id, { ...patch, ...extra })) }];
    }
    if (route === 'POST /api/staff/link') {
      if (!target || target.status === 'disabled' || target.status === 'pending') return [422, { error: 'This person can’t get a link.' }];
      const inv = newInvite();
      await db.updateStaff(target.id, { invite_hash: inv.hash, invite_expires: inv.expires });
      return [200, { invite: inv.token }];
    }
    if (route === 'POST /api/staff/remove') {
      if (!target) return [404, { error: 'Not found.' }];
      if (target.id === user.id) return [422, { error: 'You can’t remove yourself.' }];
      if (lastOwner(target)) return [422, { error: 'There must always be at least one owner.' }];
      await db.updateStaff(target.id, { status: 'disabled', invite_hash: null, invite_expires: null, token_version: target.token_version + 1 });
      return [200, { ok: true }];
    }
  }

  if (route === 'GET /api/stats') return [200, await trafficStats(env, Number(query.days) === 30 ? 30 : 7)];
  if (route === 'GET /api/reservations') {
    if (!db) return noDb;
    if (!can(user, 'res')) return forbidden;
    if (!DAY_RE.test(query.from || '') || !DAY_RE.test(query.to || '') || query.from > query.to) return [400, { error: 'from and to must be dates' }];
    const only = branchScope(user), rows = await db.listReservations({ from: query.from, to: query.to });
    return [200, (only ? rows.filter((r) => r.branch === only) : rows).map((r) => ({ ...r, confirm_token: confirmToken(r.id, env) }))];
  }
  if (route === 'POST /api/reservations/status') {
    if (!db) return noDb;
    if (!can(user, 'res')) return forbidden;
    if (!['new', 'confirmed', 'cancelled', 'noshow', 'waitlist'].includes(body.status)) return [400, { error: 'Unknown status.' }];
    const only = branchScope(user), was = await db.getReservation(body.id);
    if (!was) return [404, { error: 'Booking not found.' }];
    if (only && was.branch !== only) return forbidden;
    // taking a table again (from the waiting list, or undoing a cancel) needs one free
    if (HOLDS.includes(body.status) && !HOLDS.includes(was.status) && !body.force) {
      const settings = await loadSettings(db), sameDay = await db.listReservations({ from: was.date, to: was.date });
      if (!fits(sameDay.filter((r) => r.id !== was.id), was.branch, was.time, was.party_size, settings.booking)) return fullError;
    }
    const row = await db.updateReservation(body.id, { status: body.status, updated_at: new Date().toISOString(), updated_by: user.name });
    return [200, { ...row, confirm_token: confirmToken(row.id, env) }];
  }
  if (route === 'POST /api/reservations/add') {
    if (!db) return noDb;
    if (!can(user, 'res')) return forbidden;
    const { booking, error } = checkStaffBooking(body);
    if (error) return [422, { error }];
    const only = branchScope(user);
    if (only && booking.branch !== only) return forbidden;
    if (HOLDS.includes(booking.status) && !body.force) {
      const settings = await loadSettings(db);
      if (!fits(await db.listReservations({ from: booking.date, to: booking.date }), booking.branch, booking.time, booking.party_size, settings.booking)) return fullError;
    }
    const row = await db.addReservation({ ...booking, updated_by: user.name });
    return [200, { ...row, confirm_token: confirmToken(row.id, env) }];
  }
  if (route === 'GET /api/settings') return [200, await loadSettings(db)];
  if (route === 'POST /api/settings') {
    if (!db) return noDb;
    if (!can(user, 'members')) return forbidden;
    const { out, errs } = cleanSettings(body);
    if (errs.length) return [422, { error: 'Some settings are not valid.', errors: errs }];
    await db.saveSettings(out, user.name);
    return [200, await loadSettings(db)];
  }
  if (!backend) return [503, { error: 'Publishing is not set up: add GITHUB_TOKEN and GITHUB_REPO to the site’s environment variables.' }];
  if (route === 'GET /api/content') return [200, await backend.read(query.sha || undefined)];
  if (route === 'GET /api/history') return [200, await backend.history()];
  if (route === 'POST /api/publish') {
    const { content, files = [], message } = body;
    const needs = [...new Set(partsChanged(content, await backend.read()))];
    if (needs.some((p) => !can(user, p))) return forbidden;
    const errors = validateContent(content);
    if (errors.length) return [422, { error: 'The content has problems, nothing was published.', errors }];
    checkUploads(files);
    const msg = String(message || 'Update website content').slice(0, 200);
    return [200, await backend.publish({ content, files, message: msg, author: { name: user.name, email: user.email } })];
  }
  if (route === 'POST /api/restore') {
    const { sha } = body;
    if (!can(user, 'site')) return forbidden;
    if (!/^[0-9a-f]{7,40}$/.test(sha || '')) return [400, { error: 'Unknown version.' }];
    // Website text, photos and menu come back; news and jobs stay as they are now.
    // Anything the old version predates (a newer text, the social links) is
    // kept from today's content, so restoring never blanks part of the site.
    const [content, current] = await Promise.all([backend.read(sha), backend.read()]);
    content.news = current.news; content.jobs = current.jobs;
    for (const k of Object.keys(current)) if (!(k in content)) content[k] = current[k];
    for (const k of ['text', 'images']) content[k] = { ...current[k], ...content[k] };
    if (JSON.stringify(content) === JSON.stringify(current)) return [422, { error: 'This version is already what the website shows.' }];
    return [200, await backend.publish({ content, message: `Restore website content from ${sha}`, author: user })];
  }
  return [404, { error: 'Not found' }];
}
