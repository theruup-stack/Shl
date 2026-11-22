// SHL-samlingen – Cloudflare Pages (advanced mode)
// /api/schedule  → SHL:s spelschema med resultat och live-ställning (cache 20 s)
// /api/debug     → visar vad SHL svarar (för felsökning)
const SHL_URL = 'https://www.shl.se/api/sports-v2/game-schedule?seasonUuid=ndcf81nlb3&seriesUuid=qQ9-bb0bzEWUk&gameTypeUuid=qQ9-af37Ti40B&gamePlace=all&played=all';
const HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'sv-SE,sv;q=0.9,en;q=0.8',
  'referer': 'https://www.shl.se/game-schedule',
  'origin': 'https://www.shl.se',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/debug') {
      try {
        const r = await fetch(SHL_URL, { headers: HEADERS });
        const text = await r.text();
        let games = null; try { games = JSON.parse(text).gameInfo.length; } catch (e) {}
        return json({ ok: r.ok, status: r.status, contentType: r.headers.get('content-type'), games, start: text.slice(0, 300) });
      } catch (e) { return json({ ok: false, error: String(e) }, 500); }
    }

    if (url.pathname === '/api/schedule') {
      const cache = caches.default;
      const key = new Request(url.origin + '/api/schedule');
      let res = await cache.match(key);
      if (res) return res;
      try {
        const r = await fetch(SHL_URL, { headers: HEADERS });
        const text = await r.text();
        if (!r.ok || !text.trim().startsWith('{')) return json({ error: 'SHL svarade ' + r.status, start: text.slice(0, 200) }, 502);
        res = new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=20' } });
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      } catch (e) { return json({ error: String(e) }, 502); }
    }

    return env.ASSETS.fetch(request);
  }
};
