// Every US sportsbook's current lines from The Odds API (secret ODDS_API_KEY). One shared copy per
// sport is kept in Supabase (odds_cache) and refreshed at most every TTL minutes (NFL 10, college 30;
// ODDS_TTL_MIN overrides NFL), so the cost stays the same however many people look. A refresh costs
// 3 credits (spreads, totals and moneylines, US books) however many games there are.
// Credit guard: under 2,000 credits left, page views stop refreshing (they get the last copy) and only
// the scheduled college pulls (scheduledOdds, for closing lines) keep going.
import { rest } from './server.js';

const SPORTS = { nfl: 'americanfootball_nfl', ncaab: 'basketball_ncaab' };
const TTL = { nfl: 10, ncaab: 30 };
export const LOW_CREDITS = 2000;
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
// NFL teams become our abbreviations; college teams keep the book's name and the app matches them.
function normalize(events, sport) {
  return events.map((e) => {
    const away = sport === 'nfl' ? NFL[e.away_team] : e.away_team, home = sport === 'nfl' ? NFL[e.home_team] : e.home_team;
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
// scheduled: the timed college pull, which refreshes when the copy is over 25 minutes old and ignores the credit guard.
export async function getOdds(env, sport = 'nfl', { refresh = true, scheduled = false } = {}) {
  if (!SPORTS[sport] || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const rows = await rest(env, 'odds_cache?select=*&order=fetched_at.desc');
  const c = (rows || []).find((r) => r.sport === sport);
  const latest = (rows || []).find((r) => r.remaining != null);   // credits left on the account, from the newest pull of any sport
  const low = latest && latest.remaining < LOW_CREDITS;
  const ttl = (scheduled ? 25 : sport === 'nfl' ? +(env.ODDS_TTL_MIN || TTL.nfl) : TTL[sport]) * 60e3;
  if (c && c.data && c.data.games && Date.now() - Date.parse(c.fetched_at) < ttl) return c;
  if (!refresh || !env.ODDS_API_KEY || (low && !scheduled)) return c || null;
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
  const row = { fetched_at: stamp, remaining: Number.isFinite(rem) ? rem : null, data: { games: normalize(await r.json(), sport) } };
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

// The timed college pull (Worker cron, every 30 minutes from noon to after midnight ET). It first asks
// The Odds API's events list, which costs no credits, whether any game tips in the next 12 hours, so
// days without games cost nothing. Each pull also saves every not-yet-started game's lines to
// odds_close; the last save before tip-off is that game's closing line.
export async function scheduledOdds(env) {
  if (!env.ODDS_API_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return { skipped: 'not set up' };
  const ev = await fetch(`https://api.the-odds-api.com/v4/sports/${SPORTS.ncaab}/events?apiKey=${env.ODDS_API_KEY}`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const now = Date.now();
  if (!ev.some((e) => { const t = Date.parse(e.commence_time); return t > now && t - now < 12 * 36e5; })) return { skipped: 'no games soon' };
  const c = await getOdds(env, 'ncaab', { scheduled: true });
  if (!c || !c.data || !c.data.games) return { skipped: 'no data' };
  const rows = licensed(c.data.games).filter((g) => Date.parse(g.start) > now && g.books.length)
    .map((g) => ({ sport: 'ncaab', gkey: `${g.away}|${g.home}|${g.start}`, start: g.start, away: g.away, home: g.home, at: c.fetched_at, data: g }));
  if (rows.length) await rest(env, 'odds_close', { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal' });
  return { saved: rows.length, remaining: c.remaining };
}
