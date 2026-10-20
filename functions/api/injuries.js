// GET /api/injuries: ESPN's NBA injury list (free, unofficial), cut down to what the app shows and kept
// for 15 minutes in Cloudflare's cache so ESPN sees one request per 15 minutes however many people look.
// {at, teams: {NY: [{id, name, pos, status, note, date, ret}]}}; status is ESPN's: Out, Day-To-Day, ...
import { json } from '../../lib/server.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';

export async function onRequestGet({ waitUntil }) {
  const cache = caches.default, key = new Request('https://cache.trap-picks.internal/injuries/nba');
  const hit = await cache.match(key);
  if (hit) return hit;
  const r = await fetch(ESPN).catch(() => null);
  if (!r || !r.ok) return json({ error: 'injury list unavailable right now' }, 502);
  const d = await r.json().catch(() => ({}));
  const teams = {};
  for (const t of d.injuries || []) for (const i of t.injuries || []) {
    const a = i.athlete || {}, abbr = a.team && a.team.abbreviation;
    if (!abbr || !a.displayName) continue;
    const m = (a.links || []).map((l) => /\/id\/(\d+)/.exec(l.href || '')).find(Boolean);
    (teams[abbr] || (teams[abbr] = [])).push({ id: m ? m[1] : null, name: a.displayName, pos: a.position && a.position.abbreviation || null,
      status: i.status || '', note: i.shortComment || '', date: i.date || null, ret: (i.details && i.details.returnDate) || null });
  }
  const res = new Response(JSON.stringify({ at: new Date().toISOString(), teams }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=900' } });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
