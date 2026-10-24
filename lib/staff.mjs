// Staff accounts: passwords, one-time set-password links, roles and what
// each person may do. The routes that use these are in lib/api.mjs.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const PERMS = ['res', 'news', 'careers', 'site', 'members'];
// A role sets the starting access; an owner can then adjust each person's.
export const ROLE_PERMS = {
  owner: { res: true, news: true, careers: true, site: true, members: true },
  manager: { res: true, news: true, careers: true, site: true, members: false },
  staff: { res: true, news: false, careers: false, site: false, members: false },
};
export const ROLES = Object.keys(ROLE_PERMS);
export const STAFF_BRANCHES = ['all', 'office', 'mon-city', 'golden-palace', 'phan-chu-trinh'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const INVITE_DAYS = 7;
const MAX_TRIES = 5, LOCK_MINUTES = 15;

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function checkPassword(pw, stored) {
  const [kind, salt, key] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const got = await scrypt(String(pw), Buffer.from(salt, 'base64url'), 32);
  const want = Buffer.from(key, 'base64url');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
export const passwordProblem = (pw) => (typeof pw !== 'string' || pw.length < 8 ? 'The password needs at least 8 characters.' : pw.length > 200 ? 'That password is too long.' : '');

// A one-time link: the raw token goes in the link, only its hash is stored.
export function newInvite() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token), expires: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString() };
}
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// What may be shown about a person (never the password or link hashes).
export const publicStaff = (r) => ({
  id: r.id, email: r.email, name: r.name, role: r.role, branch: r.branch, perms: effectivePerms(r),
  status: r.status, lastLogin: r.last_login || null, createdAt: r.created_at, invitePending: !!r.invite_hash && r.status !== 'active',
});
// Owners always have everything; staff only ever see one branch's bookings.
export const effectivePerms = (r) => (r.role === 'owner' ? { ...ROLE_PERMS.owner } : Object.fromEntries(PERMS.map((k) => [k, !!(r.perms || {})[k]])));
export const can = (user, perm) => !!user && effectivePerms(user)[perm];
// The branch whose bookings this person sees; null means every branch.
export const branchScope = (user) => (user.role === 'staff' && user.branch !== 'all' && user.branch !== 'office' ? user.branch : null);

// Checks an owner's add/edit of a person. Returns { patch } or { error }.
export function cleanMember(body, isNew) {
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  const email = String(body.email || '').trim().toLowerCase();
  if (!name || name.length > 80) return { error: 'A name is needed.' };
  if (isNew && !EMAIL_RE.test(email)) return { error: 'That email doesn’t look right.' };
  const role = ROLES.includes(body.role) ? body.role : 'staff';
  let branch = STAFF_BRANCHES.includes(body.branch) ? body.branch : 'all';
  if (role === 'staff' && (branch === 'all' || branch === 'office')) return { error: 'Staff need a branch.' };
  if (role !== 'staff') branch = 'all';
  const perms = role === 'owner' ? { ...ROLE_PERMS.owner } : Object.fromEntries(PERMS.map((k) => [k, !!(body.perms || ROLE_PERMS[role])[k]]));
  if (role !== 'owner') perms.members = false; // only owners manage people
  return { patch: { name, role, branch, perms, ...(isNew ? { email } : {}) } };
}

// Sign-in with lockout. Returns { user } or { error, status }.
export async function signIn(db, email, password) {
  const row = await db.findStaff('email', String(email || '').trim().toLowerCase());
  const now = Date.now();
  if (row && row.locked_until && Date.parse(row.locked_until) > now) return { error: `Too many wrong passwords. Try again in ${Math.ceil((Date.parse(row.locked_until) - now) / 60e3)} min.`, status: 429 };
  const ok = row && row.status === 'active' && (await checkPassword(password, row.password_hash));
  if (!ok) {
    if (row) {
      const tries = (row.failed_logins || 0) + 1;
      await db.updateStaff(row.id, tries >= MAX_TRIES ? { failed_logins: 0, locked_until: new Date(now + LOCK_MINUTES * 60e3).toISOString() } : { failed_logins: tries });
    }
    if (row && row.status === 'pending') return { error: 'Your request to join hasn’t been approved yet.', status: 403 };
    if (row && row.status === 'invited') return { error: 'Set your password first, using the link the owner sent you.', status: 403 };
    return { error: 'Wrong email or password.', status: 401 };
  }
  return { user: await db.updateStaff(row.id, { failed_logins: 0, locked_until: null, last_login: new Date().toISOString() }) };
}
