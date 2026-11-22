// SHL-samlingen – Cloudflare Worker
import { getVapid, sendPush } from './push.js';
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


// ---------- Kalender (.ics) ----------
async function getSchedule(ctx, origin) {
  const cache = caches.default;
  const key = new Request(origin + '/api/schedule');
  let res = await cache.match(key);
  if (!res) {
    const r = await fetch(SHL_URL, { headers: HEADERS });
    const text = await r.text();
    if (!r.ok || !text.trim().startsWith('{')) throw new Error('SHL ' + r.status);
    res = new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=20' } });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return (await res.json()).gameInfo || [];
}
const icsEsc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const icsDate = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const teamName = t => (t.names && (t.names.long || t.names.short)) || t.code;
function fold(line) { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); } out.push(line); return out.join('\r\n'); }
function buildIcs(games, team) {
  const list = team ? games.filter(g => g.homeTeamInfo.code === team || g.awayTeamInfo.code === team) : games;
  const tname = team && list[0] ? teamName(list[0].homeTeamInfo.code === team ? list[0].homeTeamInfo : list[0].awayTeamInfo) : 'Alla lag';
  const now = icsDate(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SHL-samlingen//SV', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEsc('SHL 2026/27 – ' + tname), 'X-WR-TIMEZONE:Europe/Stockholm', 'REFRESH-INTERVAL;VALUE=DURATION:PT3H', 'X-PUBLISHED-TTL:PT3H'];
  for (const g of list) {
    const start = new Date(g.rawStartDateTime), end = new Date(start.getTime() + 150 * 60000);
    const h = teamName(g.homeTeamInfo), a = teamName(g.awayTeamInfo);
    const played = g.state === 'post-game';
    const score = played ? ' ' + g.homeTeamInfo.score + '–' + g.awayTeamInfo.score + (g.shootout ? ' (str)' : g.overtime ? ' (förl)' : '') : '';
    const sum = '🏒 ' + h + ' – ' + a + score;
    const desc = 'SHL omgång ' + (g.roundNumber || '') + '\nSänds på TV4 Play och Telia Play\n' + (played ? 'Slutresultat' + score : 'Nedsläpp ' + start.toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }));
    lines.push('BEGIN:VEVENT', 'UID:' + g.uuid + '@shl-samlingen', 'DTSTAMP:' + now, 'DTSTART:' + icsDate(start), 'DTEND:' + icsDate(end),
      fold('SUMMARY:' + icsEsc(sum)), fold('LOCATION:' + icsEsc((g.venueInfo && g.venueInfo.name) || '')), fold('DESCRIPTION:' + icsEsc(desc)),
      'STATUS:CONFIRMED', 'TRANSP:TRANSPARENT');
    if (!played) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc(h + ' – ' + a + ' börjar om en timme'), 'TRIGGER:-PT60M', 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}


// ---------- Notiser ----------
const SUBJECT = 'https://shl.theruup.workers.dev';
async function readSubs(kv) { return (await kv.get('subs', 'json')) || {}; }
const subKey = ep => { let h = 0; for (let i = 0; i < ep.length; i++) h = (h * 31 + ep.charCodeAt(i)) | 0; return 's' + (h >>> 0).toString(36) + ep.length; };
const short = t => (t.names && (t.names.short || t.names.long)) || t.code;

async function pushRoutes(request, env, url) {
  const kv = env.PUSH;
  if (!kv) return json({ error: 'Notiser är inte aktiverade (KV saknas)' }, 503);
  if (url.pathname === '/api/push/key') { const v = await getVapid(kv); return json({ key: v.pub }); }
  if (request.method !== 'POST') return json({ error: 'POST krävs' }, 405);
  const body = await request.json().catch(() => ({}));
  const subs = await readSubs(kv);
  if (url.pathname === '/api/push/subscribe') {
    const s = body.sub; if (!s || !s.endpoint || !s.keys) return json({ error: 'ogiltig prenumeration' }, 400);
    subs[subKey(s.endpoint)] = { sub: { endpoint: s.endpoint, keys: s.keys }, team: (body.team || '').toUpperCase(), reminders: body.reminders !== false, goals: body.goals !== false, at: Date.now() };
    await kv.put('subs', JSON.stringify(subs));
    return json({ ok: true, count: Object.keys(subs).length });
  }
  if (url.pathname === '/api/push/unsubscribe') {
    if (body.endpoint) { delete subs[subKey(body.endpoint)]; await kv.put('subs', JSON.stringify(subs)); }
    return json({ ok: true });
  }
  if (url.pathname === '/api/push/test') {
    const rec = body.endpoint && subs[subKey(body.endpoint)];
    if (!rec) return json({ error: 'hittar ingen prenumeration' }, 404);
    const v = await getVapid(kv);
    const st = await sendPush(rec.sub, { title: '🏒 Notiser är på', body: 'Du får påminnelser och mål för ditt lag här.', tag: 'test', url: '/' }, v, SUBJECT);
    return json({ ok: st < 300, status: st });
  }
  return json({ error: 'okänd' }, 404);
}

// Körs varje minut (cron). Gör inget alls om ingen match är nära.
async function runNotifications(env, ctx) {
  const kv = env.PUSH; if (!kv) return;
  const games = await getSchedule(ctx, 'https://shl.theruup.workers.dev');
  const now = Date.now();
  const near = games.filter(g => { const t = Date.parse(g.rawStartDateTime); return t - now < 66 * 60e3 && now - t < 4 * 3600e3; });
  if (!near.length) return;
  const subs = await readSubs(kv); const list = Object.entries(subs);
  if (!list.length) return;
  const state = (await kv.get('state', 'json')) || { g: {}, rem: {} };
  let changed = false, subsChanged = false;
  const msgs = []; // {team codes, type, data}
  for (const g of near) {
    const t = Date.parse(g.rawStartDateTime), H = g.homeTeamInfo, A = g.awayTeamInfo, id = g.uuid;
    const hs = parseInt(H.score, 10) || 0, as = parseInt(A.score, 10) || 0;
    // Påminnelse en timme innan
    if (t - now <= 62 * 60e3 && t - now > 0 && !state.rem[id]) {
      state.rem[id] = 1; changed = true;
      const tid = new Date(t).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' });
      msgs.push({ teams: [H.code, A.code], type: 'reminders', data: { title: '⏰ Om en timme: ' + short(H) + ' – ' + short(A), body: 'Nedsläpp ' + tid + ' i ' + ((g.venueInfo && g.venueInfo.name) || '') + ' · TV4 Play', tag: 'rem-' + id, url: '/?tab=live' } });
    }
    const prev = state.g[id];
    const live = g.state !== 'pre-game';
    if (!live) continue;
    if (!prev) { state.g[id] = { hs, as, st: g.state }; changed = true; if (g.state !== 'post-game') msgs.push({ teams: [H.code, A.code], type: 'goals', data: { title: '🏒 Nedsläpp: ' + short(H) + ' – ' + short(A), body: 'Matchen har börjat. Följ den live.', tag: 'g-' + id, url: '/?tab=live' } }); continue; }
    if (hs > prev.hs || as > prev.as) {
      const scorer = hs > prev.hs ? H : A;
      msgs.push({ teams: [H.code, A.code], type: 'goals', data: { title: '🚨 MÅL ' + short(scorer) + '!', body: short(H) + ' ' + hs + '–' + as + ' ' + short(A), tag: 'g-' + id, url: '/?tab=live' } });
    }
    if (g.state === 'post-game' && prev.st !== 'post-game') {
      msgs.push({ teams: [H.code, A.code], type: 'goals', data: { title: '🏁 Slut: ' + short(H) + ' ' + hs + '–' + as + ' ' + short(A), body: g.shootout ? 'Avgjort på straffar' : g.overtime ? 'Avgjort i förlängning' : 'Slutresultat', tag: 'g-' + id, url: '/?tab=live' } });
    }
    if (hs !== prev.hs || as !== prev.as || g.state !== prev.st) { state.g[id] = { hs, as, st: g.state }; changed = true; }
  }
  if (msgs.length) {
    const v = await getVapid(kv);
    const sends = [];
    for (const [k, rec] of list) for (const m of msgs) {
      if (!rec[m.type]) continue;
      if (rec.team && !m.teams.includes(rec.team)) continue;
      sends.push(sendPush(rec.sub, m.data, v, SUBJECT).then(st => { if (st === 404 || st === 410) { delete subs[k]; subsChanged = true; } }).catch(() => {}));
    }
    await Promise.all(sends);
  }
  // städa gammalt tillstånd
  for (const id of Object.keys(state.g)) if (!games.find(g => g.uuid === id && now - Date.parse(g.rawStartDateTime) < 2 * 86400e3)) { delete state.g[id]; changed = true; }
  for (const id of Object.keys(state.rem)) if (!games.find(g => g.uuid === id && now - Date.parse(g.rawStartDateTime) < 2 * 86400e3)) { delete state.rem[id]; changed = true; }
  if (changed) await kv.put('state', JSON.stringify(state));
  if (subsChanged) await kv.put('subs', JSON.stringify(subs));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cache = caches.default;

    if (url.pathname.startsWith('/api/push/')) return pushRoutes(request, env, url);

    if (url.pathname === '/api/debug') {
      try {
        const r = await fetch(SHL_URL, { headers: HEADERS });
        const text = await r.text();
        let games = null; try { games = JSON.parse(text).gameInfo.length; } catch (e) {}
        return json({ ok: r.ok, status: r.status, contentType: r.headers.get('content-type'), games, start: text.slice(0, 300) });
      } catch (e) { return json({ ok: false, error: String(e) }, 500); }
    }


    if (url.pathname === '/api/probe') {
      // Felsökning/utforskning: hämtar en sida på shl.se eller hockeyallsvenskan.se och visar råtexten
      const u = url.searchParams.get('u') || '';
      let target; try { target = new URL(u.startsWith('http') ? u : 'https://www.shl.se' + u); } catch (e) { return json({ error: 'ogiltig url' }, 400); }
      if (!/(^|\.)shl\.se$|(^|\.)hockeyallsvenskan\.se$|(^|\.)s8y\.se$/.test(target.hostname)) return json({ error: 'host ej tillåten' }, 400);
      try {
        const r = await fetch(target.toString(), { headers: HEADERS });
        const text = await r.text();
        const max = +(url.searchParams.get('max') || 60000), off = +(url.searchParams.get('off') || 0);
        return new Response(JSON.stringify({ status: r.status, type: r.headers.get('content-type'), length: text.length, off, body: text.slice(off, off + max) }), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      } catch (e) { return json({ error: String(e) }, 502); }
    }


    if (url.pathname === '/api/ics' || url.pathname.startsWith('/kalender/')) {
      // /kalender/BIF.ics (prenumeration) eller /api/ics?team=BIF[&dl=1]
      let team = url.searchParams.get('team') || '';
      const m = url.pathname.match(/^\/kalender\/([A-Za-zÅÄÖåäö0-9]+)\.ics$/);
      if (m) team = m[1];
      team = team.toUpperCase(); if (team === 'ALLA') team = '';
      try {
        const games = await getSchedule(ctx, url.origin);
        const body = buildIcs(games, team);
        const headers = { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'public, max-age=900' };
        if (url.searchParams.get('dl')) headers['content-disposition'] = 'attachment; filename="SHL-' + (team || 'alla') + '.ics"';
        return new Response(body, { headers });
      } catch (e) { return json({ error: String(e) }, 502); }
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
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNotifications(env, ctx));
  }
};
