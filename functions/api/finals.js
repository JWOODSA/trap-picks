// GET /api/finals?sport=nba|nhl|cfb|cbb&date=YYYYMMDD: that day's games from ESPN's free scoreboard, cut down to
// what the bet tracker needs to grade a bet: both teams (ESPN id, abbreviation, name), the score and whether it's final.
// Cached in Cloudflare: a day that is over for a day, today for 5 minutes. {date, games: [{a, h, s: [away, home], done}]}
import { json } from '../../lib/server.js';

const PATHS = { nba: 'basketball/nba', nhl: 'hockey/nhl', cfb: 'football/college-football', cbb: 'basketball/mens-college-basketball' };
const EXTRA = { cfb: '&groups=80&limit=300', cbb: '&groups=50&limit=400' };   // all FBS / all Division I games, not just the featured ones

export async function onRequestGet({ request, waitUntil }) {
  const u = new URL(request.url), sport = u.searchParams.get('sport'), date = u.searchParams.get('date') || '';
  if (!PATHS[sport] || !/^\d{8}$/.test(date)) return json({ error: 'need sport and date' }, 400);
  const cache = caches.default, key = new Request(`https://cache.trap-picks.internal/finals/${sport}/${date}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${PATHS[sport]}/scoreboard?dates=${date}${EXTRA[sport] || ''}`).catch(() => null);
  if (!r || !r.ok) return json({ error: 'scores unavailable right now' }, 502);
  const d = await r.json().catch(() => ({}));
  const team = (c) => ({ id: c.team && c.team.id, ab: c.team && c.team.abbreviation, nm: c.team && c.team.displayName });
  const games = [];
  for (const e of d.events || []) {
    const comp = (e.competitions || [])[0] || {}, cs = comp.competitors || [];
    const a = cs.find((c) => c.homeAway === 'away'), h = cs.find((c) => c.homeAway === 'home');
    if (!a || !h) continue;
    games.push({ a: team(a), h: team(h), s: [Number(a.score), Number(h.score)], done: !!(e.status && e.status.type && e.status.type.completed) });
  }
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '');
  const ttl = date < today ? 86400 : 300;
  const res = new Response(JSON.stringify({ date, games }), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` } });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
