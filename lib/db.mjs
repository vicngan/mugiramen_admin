// Storage for reservations and portal settings.
//
//   supabase — production. Needs SUPABASE_URL and SUPABASE_SECRET_KEY (the
//              project's secret / service_role key; it bypasses row level
//              security, so it must only ever live on the server).
//   file     — local development: JSON files under data/ (gitignored).
//
// Both return the same shapes, so lib/api.mjs doesn't know which it has.
import fs from 'node:fs/promises';
import path from 'node:path';

const COLUMNS = 'id,branch,date,time,party_size,name,phone,note,confirm_by,lang,status,created_at,updated_at,updated_by,notified_at,notify_error';
const pickCols = (r) => Object.fromEntries(COLUMNS.split(',').map((k) => [k, r[k] ?? null]));

export function makeDb(env, dataDir) {
  if (env.SUPABASE_URL && env.SUPABASE_SECRET_KEY) return supabaseDb(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  if (dataDir) return fileDb(dataDir);
  return null; // deployed without a database: reservations are switched off
}

function supabaseDb(url, key) {
  const base = url.replace(/\/$/, '') + '/rest/v1/';
  // New-style secret keys go in `apikey` only; legacy service_role keys are JWTs.
  const headers = { apikey: key, 'content-type': 'application/json', ...(key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}) };
  const rest = async (p, { method = 'GET', body, prefer } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...headers, ...(prefer ? { prefer } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`database ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const text = await r.text(); // writes without `return=representation` come back empty
    return text ? JSON.parse(text) : null;
  };
  return {
    mode: 'supabase',
    listReservations: ({ from, to }) => rest(`reservations?select=${COLUMNS}&date=gte.${from}&date=lte.${to}&order=date,time`),
    async addReservation(r) {
      const [row] = await rest(`reservations?select=${COLUMNS}`, { method: 'POST', body: r, prefer: 'return=representation' });
      return row;
    },
    async updateReservation(id, patch) {
      const rows = await rest(`reservations?id=eq.${Number(id)}&select=${COLUMNS}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
      return rows[0] || null;
    },
    // Removes bookings dated before `date`; returns how many.
    async deleteBefore(date) {
      return ((await rest(`reservations?date=lt.${date}&select=id`, { method: 'DELETE', prefer: 'return=representation' })) || []).length;
    },
    async recentFrom(ipHash, sinceIso) {
      const rows = await rest(`reservations?select=id&ip_hash=eq.${encodeURIComponent(ipHash)}&created_at=gte.${encodeURIComponent(sinceIso)}`);
      return rows.length;
    },
    async getSettings() {
      const rows = await rest('settings?select=key,value');
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    async saveSettings(values, by) {
      const now = new Date().toISOString();
      await rest('settings', { method: 'POST', body: Object.entries(values).map(([key, value]) => ({ key, value, updated_at: now, updated_by: by })), prefer: 'resolution=merge-duplicates' });
    },
  };
}

function fileDb(dir) {
  const file = (n) => path.join(dir, n + '.json');
  const read = async (n, empty) => { try { return JSON.parse(await fs.readFile(file(n), 'utf8')); } catch { return empty; } };
  const write = async (n, v) => { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(file(n), JSON.stringify(v, null, 2) + '\n'); };
  return {
    mode: 'file',
    async listReservations({ from, to }) {
      return (await read('reservations', [])).filter((r) => r.date >= from && r.date <= to).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map(pickCols);
    },
    async addReservation(r) {
      const all = await read('reservations', []);
      const row = { id: all.reduce((m, x) => Math.max(m, x.id), 0) + 1, note: '', status: 'confirmed', created_at: new Date().toISOString(), ...r };
      all.push(row); await write('reservations', all);
      return pickCols(row);
    },
    async updateReservation(id, patch) {
      const all = await read('reservations', []);
      const row = all.find((x) => x.id === Number(id));
      if (!row) return null;
      Object.assign(row, patch); await write('reservations', all);
      return pickCols(row);
    },
    async deleteBefore(date) {
      const all = await read('reservations', []), keep = all.filter((r) => r.date >= date);
      await write('reservations', keep);
      return all.length - keep.length;
    },
    async recentFrom(ipHash, sinceIso) {
      return (await read('reservations', [])).filter((r) => r.ip_hash === ipHash && r.created_at >= sinceIso).length;
    },
    getSettings: () => read('settings', {}),
    async saveSettings(values) { await write('settings', { ...(await read('settings', {})), ...values }); },
  };
}
