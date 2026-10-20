// GET /api/rankings?sport=cfb|cbb: this week's AP Top 25 for college football or men's college basketball,
// from ESPN's free (unofficial) rankings feed, kept an hour in Cloudflare's cache. ESPN team ids are the
// same ids our college data uses. {at, poll, headline, ranks: {teamId: rank}}
import { json } from '../../lib/server.js';

const PATHS = { cfb: 'football/college-football', cbb: 'basketball/mens-college-basketball' };

export async function onRequestGet({ request, waitUntil }) {
  const sport = new URL(request.url).searchParams.get('sport');
  if (!PATHS[sport]) return json({ error: 'unknown sport' }, 400);
  const cache = caches.default, key = new Request(`https://cache.trap-picks.internal/rankings/${sport}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${PATHS[sport]}/rankings`).catch(() => null);
  if (!r || !r.ok) return json({ error: 'rankings unavailable right now' }, 502);
  const d = await r.json().catch(() => ({}));
  const polls = d.rankings || [];
  const ap = polls.find((p) => p.type === 'ap') || polls.find((p) => /\bAP\b/.test(`${p.name} ${p.shortName}`));
  if (!ap) return json({ error: 'no AP poll this week' }, 404);
  const ranks = {};
  for (const x of ap.ranks || []) if (x.team && x.team.id && x.current) ranks[x.team.id] = x.current;
  const res = new Response(JSON.stringify({ at: new Date().toISOString(), poll: ap.name || 'AP Top 25', headline: ap.headline || '', ranks }),
    { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
