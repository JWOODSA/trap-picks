// Every US sportsbook's current lines from The Odds API (secret ODDS_API_KEY). One shared copy per
// sport is kept in Supabase (odds_cache) and refreshed at most every ODDS_TTL_MIN minutes (default 10,
// and 60 once fewer than 2,000 credits are left), so the cost stays the same however many people look.
// A refresh costs 3 credits (spreads, totals and moneylines, US books).
import { rest } from './server.js';

const SPORTS = { nfl: 'americanfootball_nfl' };
const NFL = { 'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL', 'Buffalo Bills': 'BUF', 'Carolina Panthers': 'CAR',
  'Chicago Bears': 'CHI', 'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE', 'Dallas Cowboys': 'DAL', 'Denver Broncos': 'DEN', 'Detroit Lions': 'DET',
  'Green Bay Packers': 'GB', 'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAX', 'Kansas City Chiefs': 'KC',
  'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC', 'Los Angeles Rams': 'LA', 'Miami Dolphins': 'MIA', 'Minnesota Vikings': 'MIN',
  'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG', 'New York Jets': 'NYJ', 'Philadelphia Eagles': 'PHI',
  'Pittsburgh Steelers': 'PIT', 'San Francisco 49ers': 'SF', 'Seattle Seahawks': 'SEA', 'Tampa Bay Buccaneers': 'TB', 'Tennessee Titans': 'TEN',
  'Washington Commanders': 'WAS' };
export const oddsSport = (s) => (SPORTS[s] ? s : null);
// Offshore books The Odds API also lists under "us". They are not licensed in any US state, so we leave them out.
const OFFSHORE = new Set(['bovada', 'betonlineag', 'mybookieag', 'betus', 'lowvig', 'BetOnline.ag', 'Bovada', 'MyBookie.ag', 'BetUS', 'LowVig.ag']);
export const licensed = (games) => games.map((g) => ({ ...g, books: g.books.filter((b) => !OFFSHORE.has(b.b)) }));

// Our compact shape: {away, home, start, books: [{b: name, t: last update, ml: [away, home], sp: [[pt, price] away, [pt, price] home], to: [[pt, price] over, [pt, price] under]}]}
function normalize(events) {
  return events.map((e) => {
    const away = NFL[e.away_team], home = NFL[e.home_team];
    if (!away || !home) return null;
    const books = (e.bookmakers || []).filter((bk) => !OFFSHORE.has(bk.key)).map((bk) => {
      const m = Object.fromEntries((bk.markets || []).map((x) => [x.key, x.outcomes || []]));
      const o = (k, name) => (m[k] || []).find((x) => x.name === name);
      const pair = (x) => (x && x.price != null && x.point != null ? [x.point, x.price] : null);
      const ml = [o('h2h', e.away_team), o('h2h', e.home_team)].map((x) => (x ? x.price : null));
      return { b: bk.title, t: bk.last_update, ml: ml[0] != null && ml[1] != null ? ml : null,
        sp: [pair(o('spreads', e.away_team)), pair(o('spreads', e.home_team))], to: [pair(o('totals', 'Over')), pair(o('totals', 'Under'))] };
    }).filter((b) => b.ml || b.sp[0] || b.to[0]);
    return { away, home, start: e.commence_time, books };
  }).filter(Boolean);
}

// The cached copy, refreshed first when it is older than the time limit. With refresh false it never
// spends credits (alerts use this when nobody has looked lately). Returns {fetched_at, remaining, data: {games}} or null.
export async function getOdds(env, sport = 'nfl', { refresh = true } = {}) {
  if (!SPORTS[sport] || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const rows = await rest(env, `odds_cache?sport=eq.${sport}&select=*`);
  const c = rows && rows[0];
  const ttl = (c && c.remaining != null && c.remaining < 2000 ? 60 : +(env.ODDS_TTL_MIN || 10)) * 60e3;
  if (c && Date.now() - Date.parse(c.fetched_at) < ttl) return c;
  if (!refresh || !env.ODDS_API_KEY) return c || null;
  // Claim the refresh so two visitors at once do not both spend credits; whoever loses keeps the old copy.
  const stamp = new Date().toISOString();
  const claimed = c
    ? await rest(env, `odds_cache?sport=eq.${sport}&fetched_at=eq.${encodeURIComponent(c.fetched_at)}`, { method: 'PATCH', body: { fetched_at: stamp }, prefer: 'return=representation' })
    : await rest(env, 'odds_cache', { method: 'POST', body: [{ sport, fetched_at: stamp, data: {} }], prefer: 'resolution=ignore-duplicates,return=representation' });
  if (!claimed || !claimed.length) return c || null;
  const url = `https://api.the-odds-api.com/v4/sports/${SPORTS[sport]}/odds?regions=us&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${env.ODDS_API_KEY}`;
  const r = await fetch(url).catch(() => null);
  if (!r || !r.ok) {
    // Put the old time back so the next visitor tries again.
    if (c) await rest(env, `odds_cache?sport=eq.${sport}`, { method: 'PATCH', body: { fetched_at: c.fetched_at }, prefer: 'return=minimal' }).catch(() => {});
    return c && c.data && c.data.games ? c : null;
  }
  const rem = parseInt(r.headers.get('x-requests-remaining'), 10);
  const row = { fetched_at: stamp, remaining: Number.isFinite(rem) ? rem : null, data: { games: normalize(await r.json()) } };
  await rest(env, `odds_cache?sport=eq.${sport}`, { method: 'PATCH', body: row, prefer: 'return=minimal' });
  return { sport, ...row };
}

// American odds to decimal, and the best line for one side across books.
export const dec = (o) => (o > 0 ? 1 + o / 100 : 1 + 100 / -o);
// side: away or home (spread), over or under (total). More points is better for a spread side and the
// under; fewer for the over. At the same number the better price wins.
export function bestLine(g, side) {
  const pick = (b) => (side === 'away' ? b.sp[0] : side === 'home' ? b.sp[1] : side === 'over' ? b.to[0] : b.to[1]);
  const better = (a, b) => { const k = side === 'over' ? -1 : 1; return a[0] !== b[0] ? k * (a[0] - b[0]) > 0 : dec(a[1]) > dec(b[1]); };
  let best = null;
  for (const b of g.books) { const x = pick(b); if (x && (!best || better(x, best.line))) best = { book: b.b, line: x }; }
  return best;
}
