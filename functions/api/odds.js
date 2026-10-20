// GET /api/odds?sport=nfl|nba|ncaab|ncaaf: every US sportsbook's current spread, total and moneyline for each game
// (lib/odds.js keeps one shared copy). 503 until ODDS_API_KEY is set. With ELITE_ONLY=true it needs
// a signed-in Elite member; during the free launch anyone can see it.
import { json, userFrom, billingGet, isElite, rest } from '../../lib/server.js';
import { getOdds, oddsSport, licensed } from '../../lib/odds.js';

export async function onRequestGet({ request, env }) {
  // ?sport=nba_props: the saved PrizePicks lines for prop check (free for everyone; never pulls).
  if (new URL(request.url).searchParams.get('sport') === 'nba_props') {
    const rows = env.SUPABASE_SERVICE_ROLE_KEY ? await rest(env, 'odds_cache?sport=eq.nba_props&select=fetched_at,data').catch(() => null) : null;
    return rows && rows.length ? json({ at: rows[0].fetched_at, players: rows[0].data.players || {} }) : json({ error: 'no lines yet' }, 404);
  }
  const sport = oddsSport(new URL(request.url).searchParams.get('sport') || 'nfl');
  if (!sport) return json({ error: 'unknown sport' }, 400);
  if (!env.ODDS_API_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'odds are not connected yet' }, 503);
  if (env.ELITE_ONLY === 'true') {
    const user = await userFrom(request, env).catch(() => null);
    if (!user) return json({ error: 'sign in' }, 401);
    if (!isElite(await billingGet(env, user.id).catch(() => null))) return json({ error: 'elite' }, 403);
  }
  const c = await getOdds(env, sport).catch(() => null);
  if (!c || !c.data || !c.data.games) return json({ error: 'odds unavailable right now' }, 502);
  return json({ at: c.fetched_at, games: licensed(c.data.games) });
}
