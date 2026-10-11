// Live-score relay for the Trap Picks app (Cloudflare Pages Function).
// GET /api/live/nfl or /api/live/nba returns ESPN's public scoreboard JSON.
// Responses are cached at the edge for 15 seconds, so ESPN sees about
// 4 requests a minute per league no matter how many people have the app open.
const PATHS = { nfl: 'football/nfl', nba: 'basketball/nba' };
const TTL = 15;

export async function onRequestGet({ params, request, waitUntil }) {
  const lg = String(params.league || '').toLowerCase();
  if (!PATHS[lg]) return json({ error: 'unknown league' }, 404);
  const cache = caches.default;
  const key = new Request(new URL(`/api/live/${lg}`, request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  let up;
  try {
    up = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${PATHS[lg]}/scoreboard`, {
      headers: { accept: 'application/json', 'user-agent': 'TrapPicks/1.0' },
    });
  } catch (e) {
    return json({ error: 'scores unavailable' }, 502);
  }
  if (!up.ok) return json({ error: `scores unavailable (${up.status})` }, 502);
  const res = new Response(await up.text(), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${TTL}` },
  });
  waitUntil(cache.put(key, res.clone()));
  return res;
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
