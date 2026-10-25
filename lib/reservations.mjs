// Online bookings from the website's reservation form: the rules they must
// meet, the tables they hold, and the email that tells the branch. A booking
// that passes these checks waits as "new" until the guest (from the link they
// are sent) or the staff confirm it. A guest who wants a full time can join
// its waiting list instead ("waitlist", which holds no table) until staff
// offer them a table.
import crypto from 'node:crypto';

export const BRANCHES = {
  'mon-city': 'Mon City, Hàm Nghi',
  'golden-palace': 'Golden Palace, Mễ Trì',
  'phan-chu-trinh': 'Phan Chu Trinh',
};
// Same defaults as the portal's Settings page (index.html → DEFAULT_SETTINGS).
export const DEFAULT_SETTINGS = {
  // tables: how many each branch offers online (0 = no limit); a booking holds
  // ceil(guests / seatsPerTable) of them for tableMinutes from its start time
  booking: { maxOnline: 10, daysAhead: 30, lastLunch: '13:30', lastDinner: '21:00', closed: [], tables: { 'mon-city': 0, 'golden-palace': 0, 'phan-chu-trinh': 0 }, seatsPerTable: 4, tableMinutes: 90 },
  // whether people can ask to join from the sign-in page (an owner approves)
  access: { allowSignup: true },
  notify: {
    'mon-city': { email: '', zalo: '0966 75 0202' },
    'golden-palace': { email: '', zalo: '0866 60 7560' },
    'phan-chu-trinh': { email: '', zalo: '0866 75 3375' },
  },
};
export const OPEN = { lunch: '10:30', dinner: '17:00' };
// Bookings hold guests' names and phone numbers (personal data under
// Decree 13/2023), so they are deleted this long after the booking date.
// The booking form tells guests the same.
export const KEEP_DAYS = 365;
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
    const tables = {};
    for (const id of Object.keys(BRANCHES)) {
      const n = Number((b.tables || {})[id] || 0);
      if (!Number.isInteger(n) || n < 0 || n > 500) errs.push(`${id}: tables must be 0–500`);
      tables[id] = n;
    }
    const seatsPerTable = Number(b.seatsPerTable ?? 4), tableMinutes = Number(b.tableMinutes ?? 90);
    if (!Number.isInteger(seatsPerTable) || seatsPerTable < 1 || seatsPerTable > 50) errs.push('seatsPerTable must be 1–50');
    if (!Number.isInteger(tableMinutes) || tableMinutes < 30 || tableMinutes > 300) errs.push('tableMinutes must be 30–300');
    out.booking = { maxOnline, daysAhead, lastLunch: b.lastLunch, lastDinner: b.lastDinner, closed, tables, seatsPerTable, tableMinutes };
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
  if (body.access) out.access = { allowSignup: !!body.access.allowSignup };
  return { out, errs };
}

// What the website's form needs to offer only bookable days and times.
export const publicRules = ({ booking: { tables, seatsPerTable, tableMinutes, ...rules } }) => ({ ...rules, open: OPEN });

// ── Tables ──
// Bookings waiting for confirmation hold their tables too, so the website
// never takes more than the branch can confirm.
export const HOLDS = ['new', 'confirmed'];
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const tablesFor = (party, r) => Math.ceil(party / r.seatsPerTable);
// Every half hour from opening to the last booking time, as the form offers.
export function slotTimes(r) {
  const out = [];
  for (const [open, last] of [[OPEN.lunch, r.lastLunch], [OPEN.dinner, r.lastDinner]]) for (let m = toMin(open); m <= toMin(last); m += 30) out.push(toHhmm(m));
  return out;
}
// Whether `party` more guests fit at `time`, given that day's bookings at the
// branch: the most tables in use at any moment of the stay, plus theirs.
export function fits(rows, branch, time, party, r) {
  const total = (r.tables || {})[branch] || 0;
  if (!total) return true;
  const start = toMin(time), end = start + r.tableMinutes;
  const held = rows.filter((x) => x.branch === branch && HOLDS.includes(x.status)).map((x) => ({ s: toMin(x.time), n: tablesFor(x.party_size, r) })).filter((x) => x.s < end && x.s + r.tableMinutes > start);
  const busiest = Math.max(0, ...[start, ...held.map((x) => x.s).filter((s) => s > start)].map((p) => held.filter((x) => x.s <= p && x.s + r.tableMinutes > p).reduce((a, x) => a + x.n, 0)));
  return busiest + tablesFor(party, r) <= total;
}
// Times that day with no room for `party`.
export const fullTimes = (rows, branch, party, r) => slotTimes(r).filter((t) => !fits(rows, branch, t, party, r));
// The free times nearest to `time`, for a guest whose time is full.
export const nearestFree = (rows, branch, date, time, party, r, now = new Date()) => {
  const h = hanoiNow(now);
  return slotTimes(r).filter((t) => (date > h.date || t > h.time) && fits(rows, branch, t, party, r))
    .sort((a, b) => Math.abs(toMin(a) - toMin(time)) - Math.abs(toMin(b) - toMin(time))).slice(0, 3).sort();
};

// "Golden Palace, Mễ Trì" (what the form sends) or "golden-palace" → id.
export function branchId(v) {
  const s = String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  if (BRANCHES[s]) return s;
  return Object.keys(BRANCHES).find((id) => s.includes(id.replace(/-/g, ' '))) || null;
}

// Today's date and the time in Hanoi, whatever the server's own timezone.
function hanoiNow(now) {
  const d = new Date(now.getTime() + 7 * 3600e3).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
}
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// Returns { booking } ready to store, or { error, field } to show the guest.
export function checkBooking(body, settings, now = new Date()) {
  const r = settings.booking;
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) return { error: 'name', field: 'name' };
  const phone = cleanPhone(body.phone);
  if (!phone) return { error: 'phone', field: 'phone' };
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
  return { booking: { branch, date, time, party_size: party, name, phone, note, confirm_by: confirmBy, lang, status: body.waitlist ? 'waitlist' : 'new' } };
}

// 0912 345 678, +84 912…, 84912… → 0912345678; '' when it isn't a number.
function cleanPhone(v) {
  let phone = String(v || '').replace(/[\s.-]/g, '');
  if (phone.startsWith('+84')) phone = '0' + phone.slice(3);
  else if (phone.startsWith('84') && phone.length > 9) phone = '0' + phone.slice(2);
  return /^0\d{8,10}$/.test(phone) ? phone : '';
}

// A booking staff add in the portal: taken by phone, or a walk-in (who may
// leave no number). The online rules don't apply, only that it's a real time
// from today on. Returns { booking } or { error }.
export function checkStaffBooking(body, now = new Date()) {
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) return { error: 'A name is needed (up to 60 characters).' };
  const phone = cleanPhone(body.phone);
  if (String(body.phone || '').trim() && !phone) return { error: 'That phone number doesn’t look right.' };
  if (!BRANCHES[body.branch]) return { error: 'Choose a branch.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '') || body.date < hanoiNow(now).date) return { error: 'Choose a date from today on.' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time || '')) return { error: 'Choose a time.' };
  const party = Number(body.party_size);
  if (!Number.isInteger(party) || party < 1 || party > 100) return { error: 'Guests must be 1–100.' };
  const status = ['new', 'confirmed', 'waitlist'].includes(body.status) ? body.status : 'confirmed';
  const source = body.source === 'walkin' ? 'walkin' : 'phone';
  return { booking: { branch: body.branch, date: body.date, time: body.time, party_size: party, name, phone, note: String(body.note || '').trim().slice(0, 500), confirm_by: 'call', lang: ['vi', 'en', 'ja'].includes(body.lang) ? body.lang : 'vi', status, source } };
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
    b.status === 'waitlist' ? `Khách #${b.id} xin vào danh sách chờ tại ${BRANCHES[b.branch]} (giờ này đã hết bàn).` : `Đặt bàn mới #${b.id} tại ${BRANCHES[b.branch]}, đang chờ xác nhận.`,
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
        subject: `${b.status === 'waitlist' ? 'Danh sách chờ' : 'Đặt bàn mới'}: ${b.name}, ${b.party_size} khách, ${b.time} ${b.date.split('-').reverse().join('/')}`,
        text: lines.join('\n'),
      }),
    });
    if (!r.ok) return { error: `email ${r.status}: ${(await r.text()).slice(0, 160)}` };
    return { sent: true };
  } catch (e) {
    return { error: 'email: ' + e.message };
  }
}
