// Visitor numbers for the admin's Settings → Website page, read from Umami
// (https://umami.is). Set UMAMI_API_KEY and UMAMI_WEBSITE_ID in the site's
// environment variables (UMAMI_API_URL defaults to Umami Cloud). The API key
// stays on the server; the admin only sees the totals.
const num = (v) => (v && typeof v === 'object' ? v.value : v) || 0;
const share = (rows) => {
  const total = rows.reduce((a, r) => a + r.y, 0) || 1;
  return rows.slice(0, 6).map((r) => [r.x || '', Math.round((r.y / total) * 100)]);
};

export async function trafficStats(env, days) {
  if (!env.UMAMI_API_KEY || !env.UMAMI_WEBSITE_ID) return { configured: false };
  const base = (env.UMAMI_API_URL || 'https://api.umami.is/v1').replace(/\/$/, '');
  const endAt = Date.now(), startAt = endAt - days * 864e5;
  const get = async (p, extra = '') => {
    const r = await fetch(`${base}/websites/${env.UMAMI_WEBSITE_ID}${p}?startAt=${startAt}&endAt=${endAt}${extra}`, { headers: { 'x-umami-api-key': env.UMAMI_API_KEY, accept: 'application/json' } });
    if (!r.ok) throw new Error(`Umami ${r.status}`);
    return r.json();
  };
  try {
    const [stats, series, pages, refs, devices, events] = await Promise.all([
      get('/stats'),
      get('/pageviews', '&unit=day&timezone=Asia/Ho_Chi_Minh'),
      get('/metrics', '&type=url').catch(() => get('/metrics', '&type=path')),
      get('/metrics', '&type=referrer'),
      get('/metrics', '&type=device'),
      get('/metrics', '&type=event').catch(() => []),
    ]);
    return {
      configured: true,
      visitors: num(stats.visitors),
      pageviews: num(stats.pageviews),
      clicks: (events.find((e) => e.x === 'reserve') || {}).y || 0,
      daily: (series.sessions || series.pageviews || []).map((d) => ({ date: String(d.x).slice(0, 10), v: d.y })),
      pages: share(pages),
      sources: share(refs),
      devices: share(devices),
    };
  } catch (e) {
    return { configured: true, error: e.message };
  }
}
