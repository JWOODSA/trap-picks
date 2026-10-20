// Smoke test: opens every screen of the app on an iPhone-size viewport and fails on script errors,
// leaked "undefined"/"NaN"/"[object" text, empty pages or sideways scrolling.
// Signed out (the public website as visitors see it) and signed in (a fake account with groups,
// leagues and drafts, so the account pages render without touching the real database).
//   node tests/smoke.mjs            # uses ./public
//   PW=/path/to/playwright node tests/smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pw = require(process.env.PW || 'playwright');
const ROOT = path.resolve(process.argv[2] || 'public');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = 8790 + Math.floor(Math.random() * 100);
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/__mock.js') { res.writeHead(200, { 'content-type': types['.js'] }); return res.end(fs.readFileSync(path.join(HERE, 'mock.js'))); }
  if (p === '/' || p === '/app') p = p === '/' ? '/index.html' : '/app.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
}).listen(PORT);

const J = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const core = J('core.json'), players = J('players.json'), fan = J('fantasy.json'), cb = J('ncaab.json'), cf = J('cfb.json'), nh = J('nhl.json');
const games = [...new Set(core.calls.map((c) => c.game_id))];
const teams = core.teams.map((t) => t.team);
const pids = players.profiles.slice(0, 8).map((p) => p.player_id);
const fids = fan.players.slice(0, 6).map((p) => p.id);
const cfids = cf.teams.slice().sort((a, b) => a.rank - b.rank).slice(0, 4).map((t) => t.id);
const cids = cb.teams.slice().sort((a, b) => a.rank - b.rank).slice(0, 5).map((t) => t.id);

const PUBLIC = ['board', 'teams', 'players', 'record', 'me', 'login', 'sports', 'nba', 'fantasy', 'fl', 'cbb', 'cbbt', 'cbbp', 'cfb', 'cfbt', 'nhl', 'nhlt',
  ...games.map((g) => 'g_' + g), ...teams.map((t) => 't_' + t), ...pids.map((p) => 'p_' + p), ...fids.map((f) => 'f_' + f), ...cids.map((c) => 'c_' + c), ...cfids.map((c) => 'cf_' + c), 'nh_CAR', 'nh_VAN'];

// Fake signed-in account: one NFL group, one NBA league, a college pick'em and a college draft in season.
const wk = Object.keys(cb.slates || {}).sort()[0];
const top = cb.teams.slice().sort((a, b) => a.rank - b.rank).map((t) => t.id);
const SEED = {
  'members/me': { groups: ['GRP001'], picks: {}, pickem: {} }, 'groups/GRP001': { name: 'Sunday Crew', created_by: 'me' },
  'members/u2': { groups: ['GRP001'], picks: {}, pickem: {} },
  'data/users/me/fantasy': { leagues: ['NBA001'] }, 'data/users/me/cbb': { leagues: ['CBP001', 'CBD001'] },
  'leagues/NBA001': { name: 'Hoop Heads', kind: 'weekly', size: 50, status: 'season', order: [], created_by: 'me', season: fan.meta.season },
  'leagues/NBA001/teams/me': { name: 'John' }, 'leagues/NBA001/teams/u2': { name: 'Marcus' },
  'leagues/CBP001': { name: 'Hoop Heads', kind: 'cbb_pickem', size: 50, rounds: 8, status: 'season', order: [], created_by: 'me', season: cb.meta.season, family: 'NBA001' },
  'leagues/CBP001/teams/me': { name: 'John' }, 'leagues/CBP001/teams/u2': { name: 'Marcus' },
  'leagues/CBD001': { name: 'Draft Night', kind: 'cbb_draft', size: 2, rounds: 8, status: 'draft', order: ['me', 'u2'], created_by: 'me', season: cb.meta.season, draft_started_at: '2026-10-01T00:00:00Z' },
  'leagues/CBD001/teams/me': { name: 'John' }, 'leagues/CBD001/teams/u2': { name: 'Marcus' },
  'links/NBA001/games/NBA001': { code: 'NBA001', kind: 'weekly', name: 'Hoop Heads', by: 'me' },
  'links/NBA001/games/CBP001': { code: 'CBP001', kind: 'cbb_pickem', name: 'Hoop Heads', by: 'me' },
};
if (wk) SEED['leagues/CBP001/entries/me_' + wk] = { uid: 'me', wk, picks: { [cb.slates[wk][0]]: cb.slate_games[String(cb.slates[wk][0])]?.home } };
for (let n = 0; n < 16; n++) { const r = Math.floor(n / 2), i = n % 2; SEED[`leagues/CBD001/picks/p${String(n).padStart(3, '0')}`] = { n, uid: ['me', 'u2'][r % 2 ? 1 - i : i], tid: top[n] }; }
SEED['data/users/me/cbb'].leagues.push('CBD002');
Object.assign(SEED, { 'leagues/CBD002': { name: 'Live Draft', kind: 'cbb_draft', size: 2, rounds: 8, status: 'draft', order: ['me', 'u2'], created_by: 'me', season: cb.meta.season, draft_started_at: '2026-10-01T00:00:00Z' },
  'leagues/CBD002/teams/me': { name: 'John' }, 'leagues/CBD002/teams/u2': { name: 'Marcus' } });
// Bets on games that have closed, so the report card has closing lines to check.
const closed = Object.keys(core.closes || {}).slice(-14);
SEED['data/users/me/bets'] = { bankroll: 500, items: Object.fromEntries(closed.map((gid, i) => {
  const [, , away, home] = gid.split('_'), c = core.closes[gid], side = i % 2 ? away : home;
  const line = (side === home ? -c[0] : c[0]) + [0.5, -0.5, 0][i % 3];
  const pick = i % 4 === 3 ? (i % 8 === 3 ? 'Over ' : 'Under ') + c[1] : i % 5 === 4 ? side + ' ML' : `${side} ${line > 0 ? '+' : ''}${line}`;
  const odds = /ML$/.test(pick) ? (side === away ? c[2] : c[3]) + 5 : -110;
  return ['b' + i, { id: 'b' + i, at: `2026-10-0${1 + (i % 9)}T18:00:00Z`, date: '2026-10-05', desc: pick, stake: 20 + i, odds, book: ['FanDuel', 'DraftKings', 'BetMGM'][i % 3],
    kind: 'single', src: i % 2 ? 'call' : null, legs: [{ game_id: gid, away, home, market: /ML$/.test(pick) ? 'moneyline' : /^(Over|Under)/.test(pick) ? 'Total' : 'Spread', pick, odds, date: '2026-10-05' }],
    shop: i % 3 ? null : { typ: -115, best: { book: 'FanDuel', pt: line, price: -110 } }, result: null }];
})) };
// A fake /api/odds answer: three books on every game this week.
const ODDS = { at: new Date().toISOString(), games: Object.entries(core.kickoff || {}).map(([gid, ko]) => {
  const [, , away, home] = gid.split('_');
  const bk = (b, sp, tt, p) => ({ b, t: ko, ml: [150 + p, -170 - p], sp: [[sp, -110 + p], [-sp, -110 - p]], to: [[tt, -112 + p], [tt, -108 - p]] });
  return { away, home, start: ko, books: [bk('FanDuel', 3.5, 44.5, 5), bk('DraftKings', 3, 45, 0), bk('BetMGM', 3.5, 44.5, -5)] };
}) };
// And a fake college answer: books on the first few college games, named the way sportsbooks name teams.
const cbName = new Map(cb.teams.map((t) => [t.id, t.bk || t.name]));
const CBODDS = { at: new Date().toISOString(), games: (cb.games || []).slice(0, 6).map((g, i) => ({ away: cbName.get(g.away), home: cbName.get(g.home), start: g.tip || `${g.date}T23:00:00Z`,
  books: [{ b: 'FanDuel', t: '', ml: null, sp: [[g.margin - 2.5 + i, -110], [-(g.margin - 2.5 + i), -110]], to: [[g.total - 3, -110], [g.total - 3, -110]] },
    { b: 'DraftKings', t: '', ml: null, sp: [[g.margin - 2 + i, -105], [-(g.margin - 2 + i), -115]], to: [[g.total - 2.5, -110], [g.total - 2.5, -110]] }] })) };
// And college football: books on the first few games between two FBS teams, with the books' "School Mascot" names.
const cfName = new Map(cf.teams.map((t) => [t.id, t.bk]));
const CFODDS = { at: new Date().toISOString(), games: (cf.games || []).filter((g) => g.kick && cfName.has(g.home) && cfName.has(g.away)).slice(0, 6).map((g, i) => ({ away: cfName.get(g.away), home: cfName.get(g.home), start: g.kick,
  books: [{ b: 'FanDuel', t: '', ml: null, sp: [[g.margin - 2.5 + i, -110], [-(g.margin - 2.5 + i), -110]], to: [[g.total - 3, -110], [g.total - 3, -110]] },
    { b: 'DraftKings', t: '', ml: null, sp: [[g.margin - 2 + i, -105], [-(g.margin - 2 + i), -115]], to: [[g.total - 2.5, -110], [g.total - 2.5, -110]] }] })) };
// And NHL: two books' moneylines and totals on every upcoming game, under the NHL's own codes.
const NHODDS = { at: new Date().toISOString(), games: (nh.games || []).map((g) => ({ away: g.away, home: g.home, start: g.start, books: [
  { b: 'FanDuel', t: '', ml: [120, -140], sp: [[1.5, -200], [-1.5, 170]], to: [[6.5, -110], [6.5, -110]] },
  { b: 'DraftKings', t: '', ml: [125, -145], sp: [[1.5, -210], [-1.5, 175]], to: [[6, -120], [6, 100]] }] })) };
// And NBA: two books on every upcoming game in the props file.
const np = J('nba_props.json');
const nbaGames = Object.entries(np.next || {}).flatMap(([t, list]) => list.filter((g) => g.home).map((g) => ({ away: g.opp, home: t, start: g.tip })));
const NBODDS = { at: new Date().toISOString(), games: nbaGames.map((g) => ({ ...g, books: [
  { b: 'FanDuel', t: '', ml: [140, -160], sp: [[4.5, -110], [-4.5, -110]], to: [[221.5, -110], [221.5, -110]] },
  { b: 'DraftKings', t: '', ml: [135, -155], sp: [[4, -108], [-4, -112]], to: [[222, -110], [222, -110]] }] })) };
const nbaSoon = nbaGames.some((g) => Date.parse(g.start) > Date.now());
// And player lines from PrizePicks and the books: the top scorer with game logs, tipping in three hours.
const ppPlayer = fan.players.filter((p) => (np.logs[String(p.id)] || []).length).sort((a, b) => b.pts - a.pts)[0];
const PPLINES = { at: new Date().toISOString(), players: ppPlayer ? { [ppPlayer.name]: { away: 'BOS', home: 'NY', start: new Date(Date.now() + 3 * 36e5).toISOString(), lines: { pts: { PrizePicks: [21.5, null], Underdog: [21.5, -122], FanDuel: [22.5, -115] }, reb: { DraftKings: [6.5, -110] } } } } : {} };
// And an injury list: the prop-check player is day-to-day, one teammate is out.
const mate = ppPlayer && fan.players.find((p) => p.team === ppPlayer.team && p.id !== ppPlayer.id);
const INJURIES = { at: new Date().toISOString(), teams: ppPlayer ? { [ppPlayer.team]: [
  { id: String(ppPlayer.id), name: ppPlayer.name, pos: 'G', status: 'Day-To-Day', note: 'Questionable for Tuesday with a sore ankle.', date: null, ret: null },
  ...(mate ? [{ id: String(mate.id), name: mate.name, pos: 'F', status: 'Out', note: 'Out with a knee injury.', date: null, ret: '2026-11-01' }] : [])] } : {} };
// And AP polls: our top teams in reverse, so the AP rank differs from ours.
const APCF = { at: new Date().toISOString(), poll: 'AP Top 25', ranks: Object.fromEntries(cfids.map((id, i) => [String(id), 5 - i])) };
const APCB = { at: new Date().toISOString(), poll: 'AP Top 25', ranks: Object.fromEntries(cids.map((id, i) => [String(id), 5 - i])) };
const oddsBody = (u) => JSON.stringify(u.includes('sport=ncaab') ? CBODDS : u.includes('sport=ncaaf') ? CFODDS : u.includes('sport=nhl') ? NHODDS : u.includes('sport=nba_props') ? PPLINES : u.includes('sport=nba') ? NBODDS : ODDS);
const SIGNED = ['cbbp_CBD002', 'me', 'grp_GRP001', 'fl', 'fl_NBA001', 'cbbp', 'cbbp_CBP001', 'cbbp_CBD001', 'bets'];

const BAD = /\bundefined\b|\bNaN\b|\[object |\bInfinity\b|(^|\s)null(\s|$)/;
const fails = [];
const browser = await pw.chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
async function run(label, routes, signedIn, website) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  let errs = [];
  page.on('pageerror', (e) => errs.push('script error: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::/.test(m.text())) errs.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.dismiss());
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (!u.startsWith(`http://localhost:${PORT}/`)) return r.abort();
    if (u.includes('/api/odds')) return r.fulfill({ status: 200, contentType: types['.json'], body: oddsBody(u) });
    if (u.includes('/api/injuries')) return r.fulfill({ status: 200, contentType: types['.json'], body: JSON.stringify(INJURIES) });
    if (u.includes('/api/rankings')) return r.fulfill({ status: 200, contentType: types['.json'], body: JSON.stringify(u.includes('sport=cfb') ? APCF : APCB) });
    if (signedIn && /\/app(\.html)?$/.test(u.split('#')[0])) {
      const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8').replace('<script>\n(() => {',
        `<script>window.TRAP_API = ${website ? '"/api"; window.TRAP_SUPABASE = undefined' : 'undefined'}; window.SEED = ${JSON.stringify(SEED)};</script><script src="/__mock.js"></script>\n<script>\n(() => {`).replace('!HOSTED && window.claude && window.claude.use', 'window.claude && window.claude.use');
      return r.fulfill({ status: 200, contentType: types['.html'], body: html });
    }
    return r.continue();
  });
  await page.goto(`http://localhost:${PORT}/app`);
  if (signedIn) await page.evaluate(() => localStorage.clear());
  for (const route of routes) {
    errs = [];
    await page.evaluate((h) => { location.hash = h; }, route);
    await page.waitForTimeout(1200);
    const st = await page.evaluate(() => {
      const v = document.getElementById('view');
      return { text: v ? v.innerText : '', kids: v ? v.children.length : 0, loading: !!(v && v.querySelector('.loading')), w: document.documentElement.scrollWidth };
    });
    const where = `${label} #${route}`;
    if (!st.kids || st.text.trim().length < 20) fails.push(`${where}: page is empty`);
    if (st.loading) fails.push(`${where}: still loading after 1.2s`);
    const m = st.text.match(BAD); if (m) fails.push(`${where}: shows "${m[0].trim()}" near "${st.text.slice(Math.max(0, m.index - 40), m.index + 20).replace(/\s+/g, ' ')}"`);
    if (st.w > 391) fails.push(`${where}: page scrolls sideways (${st.w}px wide)`);
    errs.forEach((e) => fails.push(`${where}: ${e}`));
    console.log((errs.length ? '✗ ' : '✓ ') + where);
  }
  await ctx.close();
}
// Taps: the things people do, checked against what got saved.
const TAPS = [
  ['save an NFL pick', async (p) => { await p.evaluate(() => { location.hash = 'board'; }); await p.waitForTimeout(1500);
    const b = p.locator('[data-pk]:visible'); if (!(await b.count())) return 'no open NFL calls (fine before a slate posts)';
    await b.first().click(); await p.waitForTimeout(600);
    const n = await p.evaluate(() => Object.keys((JSON.parse(localStorage.getItem('mockdb'))['data/users/me/picks'] || {}).items || {}).length); return n >= 1 || 'pick did not save'; }],
  ['make an NFL group pick', async (p) => { await p.evaluate(() => { location.hash = 'grp_GRP001'; }); await p.waitForTimeout(1500);
    const b = p.locator('.pe .opts button:not([disabled])'); if (!(await b.count())) return 'no open NFL games (fine before a slate posts)';
    await b.first().click(); await p.waitForTimeout(600);
    const pe = await p.evaluate(() => (JSON.parse(localStorage.getItem('mockdb'))['members/me'] || {}).pickem || {}); return Object.keys(pe).length >= 1 || 'group pick did not save'; }],
  ['switch sport to college', async (p) => { await p.click('#sport'); await p.waitForTimeout(400); await p.getByText('NCAAB', { exact: true }).first().click(); await p.waitForTimeout(800); return (await p.evaluate(() => location.hash)) === '#cbb' || 'did not open college games'; }],
  ['type a prop line', async (p) => { await p.evaluate((f) => { location.hash = 'f_' + f; }, fids[0]); await p.waitForTimeout(1500);
    const inp = p.locator('#prop input[aria-label="Line"]'); if (!(await inp.count())) return 'no prop check on player page';
    await inp.fill('20.5'); await inp.dispatchEvent('input'); await p.waitForTimeout(400); const t = await p.locator('#prop').innerText(); return /%/.test(t) || 'no hit rates shown'; }],
  ['make a college pick', async (p) => { await p.evaluate(() => { location.hash = 'cbbp_CBP001'; }); await p.waitForTimeout(1500);
    const b = p.locator('.pkg .pkb button:not([disabled])'); if (!(await b.count())) return 'no open games to pick (fine before a slate posts)';
    await b.nth(2).click(); await p.waitForTimeout(500); const n = await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('mockdb'))).filter((d) => d && d.picks && d.uid === 'me').reduce((a, d) => a + Object.keys(d.picks).length, 0));
    return n >= 2 || 'pick did not save'; }],
  ['draft a college team', async (p) => { await p.evaluate(() => { location.hash = 'cbbp_CBD002'; }); await p.waitForTimeout(1500);
    await p.locator('.frow button.gbtn').first().click(); await p.waitForTimeout(600);
    const ok = await p.evaluate(() => !!JSON.parse(localStorage.getItem('mockdb'))['leagues/CBD002/picks/p000']); return ok || 'draft pick did not save'; }],
  ['start a college league', async (p) => { await p.evaluate(() => { location.hash = 'cbbp'; }); await p.waitForTimeout(1500);
    await p.fill('input[aria-label="New league name"]', 'Test League'); await p.getByRole('button', { name: 'Create' }).click(); await p.waitForTimeout(1500);
    return /^#cbbp_[A-Z0-9]{6}$/.test(await p.evaluate(() => location.hash)) || 'did not open the new league'; }],
  ['leader adds a game', async (p) => { await p.evaluate(() => { location.hash = 'fl_NBA001'; }); await p.waitForTimeout(2000);
    await p.click('.gm-add summary'); await p.waitForTimeout(300); await p.getByRole('button', { name: /College team draft/ }).click(); await p.waitForTimeout(2000);
    const h = await p.evaluate(() => location.hash); const linked = await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('mockdb'))).filter((k) => k.startsWith('links/NBA001/games/')).length);
    return (/^#cbbp_/.test(h) && linked >= 3) || `add game failed (${h}, ${linked} links)`; }],
];
async function taps() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage(); let errs = [];
  page.on('pageerror', (e) => errs.push('script error: ' + e.message)); page.on('dialog', (d) => d.accept());
  await page.route('**/*', (r) => { const u = r.request().url(); if (!u.startsWith(`http://localhost:${PORT}/`)) return r.abort();
    if (/\/app(\.html)?$/.test(u.split('#')[0])) return r.fulfill({ status: 200, contentType: types['.html'], body: fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8').replace('<script>\n(() => {',
      `<script>window.TRAP_API = undefined; window.SEED = ${JSON.stringify(SEED)};</script><script src="/__mock.js"></script>\n<script>\n(() => {`) });
    return r.continue(); });
  await page.goto(`http://localhost:${PORT}/app`); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForTimeout(1500);
  for (const [name, fn] of TAPS) {
    errs = [];
    let res; try { res = await fn(page); } catch (e) { res = e.message.split('\n')[0]; }
    if (res !== true && !/fine before/.test(res)) fails.push(`tap: ${name}: ${res}`);
    errs.forEach((e) => fails.push(`tap: ${name}: ${e}`));
    console.log((res === true && !errs.length ? '✓ ' : '✗ ') + 'tap: ' + name + (res === true ? '' : ' (' + res + ')'));
  }
  await ctx.close();
}
// Website-only taps (line shopping and custom alerts need the site's /api).
async function website() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/New_York' });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push('script error: ' + e.message));
  await p.route('**/*', (r) => { const u = r.request().url(); if (!u.startsWith(`http://localhost:${PORT}/`)) return r.abort();
    if (u.includes('/api/odds')) return r.fulfill({ status: 200, contentType: types['.json'], body: oddsBody(u) });
    if (u.includes('/api/injuries')) return r.fulfill({ status: 200, contentType: types['.json'], body: JSON.stringify(INJURIES) });
    if (u.includes('/api/rankings')) return r.fulfill({ status: 200, contentType: types['.json'], body: JSON.stringify(u.includes('sport=cfb') ? APCF : APCB) });
    if (u.includes('/api/')) return r.fulfill({ status: 404, body: '{}' });
    if (/\/app(\.html)?$/.test(u.split('#')[0])) return r.fulfill({ status: 200, contentType: types['.html'], body: fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8').replace('<script>\n(() => {',
      `<script>window.TRAP_API = "/api"; window.TRAP_SUPABASE = undefined; window.SEED = ${JSON.stringify(SEED)};</script><script src="/__mock.js"></script>\n<script>\n(() => {`)
      .replace('!HOSTED && window.claude && window.claude.use', 'window.claude && window.claude.use') });   // the fake account stands in for Supabase here
    return r.continue(); });
  await p.goto(`http://localhost:${PORT}/app`); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1500);
  const gid = Object.keys(core.kickoff || {}).find((g) => Date.parse(core.kickoff[g]) > Date.now());
  let res = true;
  if (!gid) res = 'no upcoming games (fine before a slate posts)';
  else {
    await p.evaluate((g) => { location.hash = 'g_' + g; }, gid); await p.waitForTimeout(1500);
    const t = await p.locator('.shop-card').innerText().catch(() => '');
    if (!/FanDuel|DraftKings|BetMGM/.test(t)) res = 'line shopping did not show sportsbook prices';
    else {
      await p.getByRole('button', { name: /Alert me on this game/ }).click(); await p.waitForTimeout(300);
      await p.getByRole('button', { name: 'Set alert' }).click(); await p.waitForTimeout(600);
      const r = await p.evaluate(() => Object.values((JSON.parse(localStorage.getItem('mockdb'))['data/users/me/alerts'] || {}).rules || {}));
      if (!(r.length === 1 && r[0].kind === 'line' && Number.isFinite(r[0].target))) res = 'alert did not save: ' + JSON.stringify(r);
    }
  }
  if (res === true && (cb.games || []).length) {
    await p.evaluate(() => { location.hash = 'cbb'; }); await p.waitForTimeout(2000);
    const t = await p.locator('#view').innerText();
    if (!/Books: /.test(t)) res = 'college games did not show sportsbook lines';
  }
  if (res === true && CFODDS.games.length) {
    await p.evaluate(() => { location.hash = 'cfb'; }); await p.waitForTimeout(2000);
    const t = await p.locator('#view').innerText();
    if (!/Books: /.test(t)) res = 'college football games did not show sportsbook lines';
    const cs = p.locator('.cg-shop summary').first();
    if (res === true && !(await cs.count())) res = 'college football games did not show line shopping';
    else if (res === true) { await cs.click(); await p.waitForTimeout(300); if (!/FanDuel|DraftKings/.test(await p.locator('.cg-shop').first().innerText())) res = 'college football line shopping did not show sportsbook prices'; if (process.env.SHOTS) { const c = p.locator('.cg-shop').first(); await c.scrollIntoViewIfNeeded(); await p.screenshot({ path: path.join(process.env.SHOTS, 'cfb-shop.png') }); } }
    await p.evaluate(() => { location.hash = 'cfbt'; }); await p.waitForTimeout(1500);
    if (res === true && !/AP \d/.test(await p.locator('#view').innerText())) res = 'college football rankings did not show the AP rank';
  }
  if (res === true && NHODDS.games.length) {
    await p.evaluate(() => { location.hash = 'nhl'; }); await p.waitForTimeout(2000);
    const t = await p.locator('#view').innerText();
    if (!/Books: [A-Z]{3} \d+%/.test(t)) res = 'NHL games did not show sportsbook prices';
    if (res === true && !(await p.locator('.cg-shop').count())) res = 'NHL games did not show line shopping';
  }
  if (res === true && nbaSoon) {
    await p.evaluate(() => { location.hash = 'nba'; }); await p.waitForTimeout(2500);
    const sum = p.locator('.nshop summary').first();
    if (!(await sum.count())) res = 'NBA games did not show line shopping';
    else { await sum.click(); await p.waitForTimeout(300); const t = await p.locator('.nshop').first().innerText(); if (!/FanDuel|DraftKings/.test(t)) res = 'NBA line shopping did not show sportsbook prices'; }
  }
  if (res === true && ppPlayer) {
    await p.evaluate((id) => { location.hash = 'f_' + id; }, ppPlayer.id); await p.waitForTimeout(2500);
    const t = await p.locator('#prop').innerText().catch(() => '');
    if (!/Day-to-day/.test(t)) res = 'prop check did not show his injury';
    else if (!/Tonight's PTS lines[\s\S]*PrizePicks[\s\S]*21\.5[\s\S]*FanDuel/.test(t)) res = 'prop check did not show the book lines';
    if (process.env.SHOTS) await p.locator('#prop').screenshot({ path: path.join(process.env.SHOTS, 'prizepicks.png') });
  }
  if (res === true) for (const [hash, nm] of [['board', 'NFL'], ['nba', 'NBA'], ['cbb', 'college'], ['cfb', 'college football'], ...(nh.games.length > 1 ? [['nhl', 'NHL']] : [])]) {
    await p.evaluate((x) => { location.hash = x; }, hash); await p.waitForTimeout(2500);
    const sw = p.locator('.swipe-wrap').first();
    if (!(await sw.count()) || (await p.locator('.swipe .sw-card').count()) < 2) { res = `${nm} page has no swipe row`; break; }
    if (process.env.SHOTS) { await sw.scrollIntoViewIfNeeded(); await p.screenshot({ path: path.join(process.env.SHOTS, `swipe-${hash}.png`) }); }
  }
  if (res !== true && !/fine before/.test(res)) fails.push('tap: set a line alert: ' + res);
  errs.forEach((e) => fails.push('tap: set a line alert: ' + e));
  console.log((res === true && !errs.length ? '✓ ' : '✗ ') + 'tap: line shopping + set a line alert' + (res === true ? '' : ' (' + res + ')'));
  await ctx.close();
}
async function landing() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.route('**/*', (r) => r.request().url().startsWith(`http://localhost:${PORT}/`) ? r.continue() : r.abort());
  await p.goto(`http://localhost:${PORT}/`); await p.waitForTimeout(1500);
  const st = await p.evaluate(() => ({ w: document.documentElement.scrollWidth, t: document.body.innerText }));
  if (st.w > 391) fails.push(`home page: scrolls sideways (${st.w}px)`);
  const m = st.t.match(BAD); if (m) fails.push(`home page: shows "${m[0].trim()}"`);
  errs.forEach((e) => fails.push('home page: script error: ' + e));
  console.log((errs.length ? '✗ ' : '✓ ') + 'home page'); await ctx.close();
}
await landing();
await run('signed out', PUBLIC, false);
await run('signed in', SIGNED, true);
await run('signed in, website', ['me', 'bets', 'cbb', 'cfb', 'nhl', ...Object.keys(core.kickoff || {}).slice(0, 3).map((g) => 'g_' + g)], true, true);
await website();
await taps();
await browser.close(); server.close();
if (fails.length) { console.log('\nFAILED\n' + fails.map((f) => ' - ' + f).join('\n')); process.exit(1); }
console.log('\nAll screens passed.');
