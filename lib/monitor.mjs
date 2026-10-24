// Reporting problems to ACASOHQ, ACASO's monitoring for all client projects. Set MONITOR_URL and MONITOR_KEY
// (Netlify → Environment variables; the key comes from Mugi admin's settings in ACASOHQ). Without them, problems
// are only logged, as before. Sending never throws and waits at most 3 seconds, so ACASOHQ being slow or down
// can't break the portal or a guest's booking. Never send guests' names or phone numbers here.
export async function report(env, level, source, message, opts = {}) {
  const text = String(message).slice(0, 1000);
  if (level === 'info') console.log(`[${source}]`, text);
  else console.error(`[${source}]`, text);
  if (!env.MONITOR_URL || !env.MONITOR_KEY) return;
  try {
    const res = await fetch(`${env.MONITOR_URL.replace(/\/+$/, '')}/api/ingest/event`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.MONITOR_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ level, source, message: text, ...opts }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) console.error(`[monitor] ACASOHQ answered ${res.status}`);
  } catch (e) {
    console.error('[monitor] could not reach ACASOHQ:', e.message);
  }
}

// A message from the portal's feedback button, passed on to ACASOHQ (POST /api/ingest/message). The key stays
// here on the server. Waits at most 5 seconds and never throws: answers { ok } or { error: 'off' | 'busy' |
// 'failed' }, so the portal can show a friendly message.
export async function sendMessage(env, msg) {
  if (!env.MONITOR_URL || !env.MONITOR_KEY) {
    console.error('[feedback] MONITOR_URL and MONITOR_KEY are not set; the message was not sent');
    return { error: 'off' };
  }
  try {
    const res = await fetch(`${env.MONITOR_URL.replace(/\/+$/, '')}/api/ingest/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.MONITOR_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return { ok: true };
    console.error(`[feedback] ACASOHQ answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { error: res.status === 429 ? 'busy' : 'failed' };
  } catch (e) {
    console.error('[feedback] could not reach ACASOHQ:', e.message);
    return { error: 'failed' };
  }
}
