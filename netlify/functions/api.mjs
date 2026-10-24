// The admin API on Netlify. Same routes as the local dev server (lib/api.mjs);
// publishing commits to the site's GitHub repo, which redeploys the site.
//
// Site settings → Environment variables:
//   ADMIN_PASSWORD   required: the sign-in password
//   GITHUB_TOKEN     fine-grained token, "Contents: read and write" on this repo
//   GITHUB_REPO      the public site's repo, e.g. vicngan/mugiramen_webpage
//   GITHUB_BRANCH    optional, defaults to main (the branch the site deploys from)
//   SESSION_SECRET   optional, any long random string
//   UMAMI_API_KEY, UMAMI_WEBSITE_ID   optional, real visitor numbers
//   SUPABASE_URL, SUPABASE_SECRET_KEY   the reservations database
//   RESEND_API_KEY, NOTIFY_FROM          optional, emails each branch its new bookings
//   ADMIN_URL                            optional, this portal's address, linked in those emails
//   MONITOR_URL, MONITOR_KEY             optional, report failures and send feedback to ACASOHQ (lib/monitor.mjs)
import { handleApi, makeBackend } from '../../lib/api.mjs';
import { makeDb } from '../../lib/db.mjs';
import { report } from '../../lib/monitor.mjs';

export const config = { path: '/api/*' };

export default async (req) => {
  const env = { ...process.env, NETLIFY: process.env.NETLIFY || 'true' };
  const url = new URL(req.url);
  let body = {};
  if (req.method === 'POST') {
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
  }
  try {
    const [status, json] = await handleApi(
      { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.get('authorization') || '',
        // the website reaches us through its proxy, which passes the guest's address along
        ip: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-nf-client-connection-ip') || '' },
      { backend: makeBackend(env), db: makeDb(env), env },
    );
    if (status >= 500) await report(env, 'error', 'api', `${req.method} ${url.pathname} answered ${status}: ${json?.error ?? ''}`);
    return Response.json(json, { status, headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    await report(env, 'error', 'api', `${req.method} ${url.pathname} failed: ${e.message}`, { detail: e.stack?.slice(0, 4000) });
    return Response.json({ error: e.message }, { status: 500 });
  }
};
