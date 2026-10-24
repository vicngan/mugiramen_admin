// Runs once a day on Netlify (scheduled functions run on the published deploy).
//   - Deletes bookings older than KEEP_DAYS, as the booking form promises.
//   - Touches the database, so the free Supabase project never pauses for
//     a week without activity (a paused database would break the form).
import { makeDb } from '../../lib/db.mjs';
import { KEEP_DAYS, loadSettings } from '../../lib/reservations.mjs';

export const config = { schedule: '@daily' };

export default async () => {
  const db = makeDb(process.env);
  if (!db) return new Response('no database configured');
  await loadSettings(db);
  const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  const removed = await db.deleteBefore(cutoff);
  console.log(`daily: removed ${removed} booking(s) dated before ${cutoff}`);
  return new Response(`ok: removed ${removed}`);
};
