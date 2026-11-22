// SHL-samlingen – Cloudflare Worker
// /api/schedule → SHL:s spelschema med resultat och live-ställning (cache 20 s)
// /api/videos   → senaste videorna från alla YouTube-kanaler via RSS (cache 10 min)
// /api/debug    → visar vad SHL svarar (felsökning)
// /api/vdebug   → visar hur många videor varje kanal gav (felsökning)

const SHL_URL = 'https://www.shl.se/api/sports-v2/game-schedule?seasonUuid=ndcf81nlb3&seriesUuid=qQ9-bb0bzEWUk&gameTypeUuid=qQ9-af37Ti40B&gamePlace=all&played=all';
const HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'sv-SE,sv;q=0.9,en;q=0.8',
  'referer': 'https://www.shl.se/game-schedule',
  'origin': 'https://www.shl.se',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
};

// Alla kanaler som sidan visar (klubbar, liga, poddar, media)
export const CHANNELS = [
  'UCoyXuVb55Y3GRa0_9ZtkHEw','UCrZ1_5qilZHKWt2tk7dtt1g','UC6DO-PzFa6qBujO-h6_uR0Q','UCuWIsl2eQnRcaurgyJPg4fg',
  'UCEmipbkr9vMKLYIHhey568w','UCFKSt_ESvC9VGWzxne3MI9Q','UCgdvUES37hh_0DD0KMPwuSQ','UCcCFVACCzEFPkpU3_p6Edww',
  'UCC_xcat3QNRbe7rChAVpDSQ','UCsJ-RahDfQi2s7f6nc0qD_A','UC8cVj1SVygzHNS1Y8KwlaBw','UCDcwzc1_fYlodzWC7eMpCeA',
  'UC9CHR79injuMuuGpsJfB6Cw','UC7RSaftusTCQ-vYuzi5f5XA','UCUMwsAsbK-SsW5GHufJJFUA',
  'UCEExj5LjDeHlSY5ioiAOJiQ','UCtZC2DyDpb5sXf6ZesOxzpg','UC_PmagXpiQuaGystkQ7cWtA','UCiGv-M054YCT_LJrqxnwC1w',
  'UCjOaUSw9dXwSj1H6ZLnkt4w','UC_cMEZpPZguKdo-xxdubi6w','UC3iZc396g5qL-9mDVQzi2gA','UCpkxdVrV8DRLi-xEFR5XV1w',
  'UCuPo0m0SiXuhF2YlDAxfrNQ','UCaEDZA0Cv_voLgrl1To5CsA','UCVN7FlwJbC9Om9QJDaf1zmA','UCQmle3K2yCcpy55VNWdp2hA'
];

const json = (obj, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache } });

const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

export function parseFeed(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => {
    const e = m[1];
    const g = re => (e.match(re) || [])[1];
    return {
      v: g(/<yt:videoId>([^<]+)<\/yt:videoId>/),
      title: decode(g(/<title>([^<]*)<\/title>/) || ''),
      published: g(/<published>([^<]+)<\/published>/),
      views: +(g(/<media:statistics views="(\d+)"/) || 0),
      short: /\/shorts\//.test(g(/<link rel="alternate" href="([^"]+)"/) || '')
    };
  }).filter(x => x.v && x.published);
}

async function fetchFeeds() {
  const res = await Promise.allSettled(CHANNELS.map(id =>
    fetch('https://www.youtube.com/feeds/videos.xml?channel_id=' + id, { headers: { 'user-agent': HEADERS['user-agent'], 'accept-language': 'sv-SE,sv;q=0.9' } })
      .then(r => r.ok ? r.text() : Promise.reject(r.status))
      .then(xml => [id, parseFeed(xml)])
  ));
  const out = {}, status = {};
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') { out[r.value[0]] = r.value[1]; status[CHANNELS[i]] = r.value[1].length; }
    else status[CHANNELS[i]] = 'fel ' + r.reason;
  });
  return { out, status };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cache = caches.default;

    if (url.pathname === '/api/debug') {
      try {
        const r = await fetch(SHL_URL, { headers: HEADERS });
        const text = await r.text();
        let games = null; try { games = JSON.parse(text).gameInfo.length; } catch (e) {}
        return json({ ok: r.ok, status: r.status, contentType: r.headers.get('content-type'), games, start: text.slice(0, 300) });
      } catch (e) { return json({ ok: false, error: String(e) }, 500); }
    }

    if (url.pathname === '/api/schedule') {
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

    if (url.pathname === '/api/videos' || url.pathname === '/api/vdebug') {
      if (url.pathname === '/api/vdebug') {
        const { status } = await fetchFeeds();
        return json({ channels: CHANNELS.length, status });
      }
      const key = new Request(url.origin + '/api/videos');
      let res = await cache.match(key);
      if (res) return res;
      const { out } = await fetchFeeds();
      if (!Object.keys(out).length) return json({ error: 'inga flöden' }, 502);
      res = json({ fetched: new Date().toISOString(), channels: out }, 200, 'public, max-age=600');
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }

    return env.ASSETS.fetch(request);
  }
};
