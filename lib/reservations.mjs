// Online bookings from the website's reservation form: the rules they must
// meet, and the email that tells the branch. Bookings are confirmed as soon as
// they pass these checks; staff can still cancel or mark a no-show.
import crypto from 'node:crypto';

export const BRANCHES = {
  'mon-city': 'Mon City, Hàm Nghi',
  'golden-palace': 'Golden Palace, Mễ Trì',
  'phan-chu-trinh': 'Phan Chu Trinh',
};
// Same defaults as the portal's Settings page (index.html → DEFAULT_SETTINGS).
export const DEFAULT_SETTINGS = {
  booking: { maxOnline: 10, daysAhead: 30, lastLunch: '13:30', lastDinner: '21:00', closed: [] },
  notify: {
    'mon-city': { email: '', zalo: '0966 75 0202' },
    'golden-palace': { email: '', zalo: '0866 60 7560' },
    'phan-chu-trinh': { email: '', zalo: '0866 75 3375' },
  },
};
export const OPEN = { lunch: '10:30', dinner: '17:00' };
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);

export async function loadSettings(db) {
  const saved = db ? await db.getSettings() : {};
  return Object.fromEntries(SETTINGS_KEYS.map((k) => [k, { ...DEFAULT_SETTINGS[k], ...(saved[k] || {}) }]));
}

// Only these groups, with these field types, can be saved from the portal.
export function cleanSettings(body) {
  const out = {}, errs = [];
  const hhmm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  if (body.booking) {
    const b = body.booking;
    const maxOnline = Number(b.maxOnline), daysAhead = Number(b.daysAhead);
    if (!Number.isInteger(maxOnline) || maxOnline < 1 || maxOnline > 100) errs.push('maxOnline must be 1–100');
    if (!Number.isInteger(daysAhead) || daysAhead < 1 || daysAhead > 365) errs.push('daysAhead must be 1–365');
    if (!hhmm(b.lastLunch) || !hhmm(b.lastDinner)) errs.push('last booking times must be HH:MM');
    const closed = Array.isArray(b.closed) ? b.closed.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 200) : [];
    out.booking = { maxOnline, daysAhead, lastLunch: b.lastLunch, lastDinner: b.lastDinner, closed };
  }
  if (body.notify) {
    out.notify = {};
    for (const id of Object.keys(BRANCHES)) {
      const n = body.notify[id] || {};
      const email = String(n.email || '').trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.push(`${id}: email doesn't look right`);
      out.notify[id] = { email, zalo: String(n.zalo || '').trim().slice(0, 20) };
    }
  }
  return { out, errs };
}

// What the website's form needs to offer only bookable days and times.
export const publicRules = (s) => ({ ...s.booking, open: OPEN });

// "Golden Palace, Mễ Trì" (what the form sends) or "golden-palace" → id.
export function branchId(v) {
  const s = String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  if (BRANCHES[s]) return s;
  return Object.keys(BRANCHES).find((id) => s.includes(id.replace(/-/g, ' '))) || null;
}

// Today's date and the time in Hanoi, whatever the server's own timezone.
const hanoiNow = (now) => {
  const d = new Date(now.getTime() + 7 * 3600e3).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
};
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// Returns { booking } ready to store, or { error, field } to show the guest.
export function checkBooking(body, settings, now = new Date()) {
  const r = settings.booking;
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) return { error: 'name', field: 'name' };
  let phone = String(body.phone || '').replace(/[\s.-]/g, '');
  if (phone.startsWith('+84')) phone = '0' + phone.slice(3);
  else if (phone.startsWith('84') && phone.length > 9) phone = '0' + phone.slice(2);
  if (!/^0\d{8,10}$/.test(phone)) return { error: 'phone', field: 'phone' };
  const branch = branchId(body.branch);
  if (!branch) return { error: 'branch', field: 'branch' };
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(String(body.datetime || ''));
  if (!m) return { error: 'datetime', field: 'datetime' };
  const [, date, time] = m;
  const h = hanoiNow(now);
  if (date < h.date || (date === h.date && time <= h.time)) return { error: 'past', field: 'datetime' };
  if (date > addDays(h.date, r.daysAhead)) return { error: 'tooFar', field: 'datetime' };
  if (r.closed.includes(date)) return { error: 'closed', field: 'datetime' };
  const lunch = time >= OPEN.lunch && time <= r.lastLunch, dinner = time >= OPEN.dinner && time <= r.lastDinner;
  if (!lunch && !dinner) return { error: 'hours', field: 'datetime' };
  const party = Number(body.party_size);
  if (!Number.isInteger(party) || party < 1) return { error: 'party', field: 'party' };
  if (party > r.maxOnline) return { error: 'tooMany', field: 'party' };
  const confirmBy = ['call', 'sms', 'zalo'].includes(body.confirm_by) ? body.confirm_by : 'call';
  const lang = ['vi', 'en', 'ja'].includes(body.lang) ? body.lang : 'vi';
  const note = String(body.note || '').trim().slice(0, 500);
  return { booking: { branch, date, time, party_size: party, name, phone, note, confirm_by: confirmBy, lang, status: 'confirmed' } };
}

// A daily-rotating hash of the visitor's address, enough to rate-limit
// without keeping the address itself.
export const ipHash = (ip, secret) => crypto.createHash('sha256').update(`${new Date().toISOString().slice(0, 10)}:${secret}:${ip}`).digest('hex').slice(0, 32);

// Email the branch about a new booking. Uses Resend (https://resend.com) when
// RESEND_API_KEY is set; NOTIFY_FROM is the sender, e.g. "MUGI <booking@mugi.vn>".
// Returns { sent: true } or { error }.
export async function notifyBranch(env, settings, b) {
  const to = settings.notify[b.branch]?.email;
  if (!to) return { error: 'no email set for this branch' };
  if (!env.RESEND_API_KEY) return { error: 'email sending is not set up (RESEND_API_KEY)' };
  const via = { call: 'gọi điện', sms: 'tin nhắn SMS', zalo: 'Zalo' }[b.confirm_by];
  const day = new Date(b.date + 'T00:00:00Z').toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const lines = [
    `Đặt bàn mới #${b.id} tại ${BRANCHES[b.branch]} (đã tự động xác nhận).`,
    '',
    `Khách: ${b.name}`,
    `Điện thoại: ${b.phone}`,
    `Ngày: ${day}`,
    `Giờ: ${b.time}`,
    `Số khách: ${b.party_size}`,
    `Khách muốn được liên hệ qua: ${via}`,
    ...(b.note ? [`Ghi chú: ${b.note}`] : []),
    '',
    env.ADMIN_URL ? `Xem trong trang quản trị: ${env.ADMIN_URL.replace(/\/$/, '')}/` : '',
  ];
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.NOTIFY_FROM || 'MUGI <onboarding@resend.dev>',
        to: [to],
        subject: `Đặt bàn mới: ${b.name}, ${b.party_size} khách, ${b.time} ${b.date.split('-').reverse().join('/')}`,
        text: lines.join('\n'),
      }),
    });
    if (!r.ok) return { error: `email ${r.status}: ${(await r.text()).slice(0, 160)}` };
    return { sent: true };
  } catch (e) {
    return { error: 'email: ' + e.message };
  }
}
