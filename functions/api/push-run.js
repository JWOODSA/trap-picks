// POST /api/push-run: send any alerts in /alerts/alerts.json that have not gone out yet.
// Safe for anyone to call: it only ever sends each alert once (the push_sent row is claimed before
// sending), so the GitHub Action calls it after each data push and on a schedule.
//
// The very first run records every current alert as sent without sending, so turning alerts on
// does not flood phones with the week's backlog. A TRAP or WATCH call that disappears before
// kickoff after it was announced gets one "call pulled" alert.
import { json, rest, isPro } from '../../lib/server.js';
import { sendPush } from '../../lib/webpush.js';
import { getOdds, bestLine } from '../../lib/odds.js';

const PREF = { call: 'calls', pull: 'calls', move: 'moves', result: 'results' };
const MAX_ALERTS = 12;   // per run; the rest go on the next run
const BATCH = 25;        // pushes in flight at once

export async function onRequest({ request, env }) {
  if (!['POST', 'GET'].includes(request.method)) return json({ error: 'POST' }, 405);
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'alerts are not set up yet' }, 503);
  const res = await env.ASSETS.fetch(new URL('/alerts/alerts.json', request.url));
  if (!res.ok) return json({ error: `alerts.json ${res.status}` }, 500);
  const feed = await res.json();
  const now = Date.now();
  const live = (feed.alerts || []).filter((a) => Date.parse(a.expires) > now);

  const since = new Date(now - 10 * 864e5).toISOString();
  const sent = await rest(env, `push_sent?select=id,kind,data&sent_at=gt.${since}&order=sent_at.asc`);
  const sentIds = new Set(sent.map((r) => r.id));
  if (!sent.length && !(await rest(env, 'push_sent?select=id&limit=1')).length) {
    if (live.length) await rest(env, 'push_sent', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: live.map((a) => row(a, 0)) });
    return json({ seeded: live.length });
  }

  // Line moves on a live TRAP: a point or more since the last alert about it, or across 3 or 7.
  const last = new Map();
  for (const r of sent) if ((r.kind === 'call' || r.kind === 'move') && r.data && r.data.line != null) last.set(r.data.key, r.data);
  const moves = live.filter((a) => a.kind === 'call' && sentIds.has(a.id) && last.has(a.key) && a.line != null).flatMap((a) => {
    const was = last.get(a.key), d = Math.abs(a.line - was.line);
    const key = !a.key.endsWith(':Total') && [3, 7].some((k) => Math.sign(Math.abs(was.line) - k) !== Math.sign(Math.abs(a.line) - k));   // onto, off or across 3 or 7
    if (d < 1 && !key) return [];
    return [{ ...a, id: `move:${a.id}:${a.line}`, kind: 'move', title: `Line moved: ${a.pick}`,
      body: `${a.game}. Was ${was.pick}, now ${a.pick}. Still a TRAP at the new number.` }];
  });
  // Calls announced earlier that are gone now, before kickoff.
  const callKeys = new Set(live.filter((a) => a.kind === 'call').map((a) => a.key));
  const pulls = sent.filter((r) => r.kind === 'call' && r.data && Date.parse(r.data.expires) > now && !callKeys.has(r.data.key)).map((r) => ({
    id: 'pull:' + r.id, kind: 'pull', key: r.data.key, gid: r.data.gid, pro: r.data.pro, expires: r.data.expires, url: r.data.url,
    title: `Call pulled: ${(last.get(r.data.key) || r.data).pick}`, body: `${r.data.game}. This is no longer a ${r.data.label} call. If you already bet it, nothing changes on your ticket.`,
  }));
  const todo = [...live, ...pulls, ...moves].filter((a) => !sentIds.has(a.id)).slice(0, MAX_ALERTS);
  // Each person's own alerts (data/users/<id>/alerts), checked against the latest lines.
  const ruleDocs = (await rest(env, 'docs?select=path,data&path=like.data/users/*/alerts').catch(() => null) || [])
    .filter((d) => d.data && d.data.rules && Object.keys(d.data.rules).length);
  if (!todo.length && !ruleDocs.length) return json({ sent: 0 });

  const subs = await rest(env, 'push_subs?select=endpoint,p256dh,auth,user_id,prefs');
  let pro = new Set();
  const uids = [...new Set(subs.map((s) => s.user_id).filter(Boolean))];
  if (todo.some((a) => a.pro) && uids.length) {
    const b = await rest(env, `billing?select=id,pro_until&id=in.(${uids.join(',')})`);
    pro = new Set(b.filter(isPro).map((x) => x.id));
  }
  const gone = new Set(), auths = new Map(), report = [];
  for (const a of todo) {
    const claimed = await rest(env, 'push_sent', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation', body: [row(a, 0)] });
    if (!claimed || !claimed.length) continue;   // another run has it
    const to = subs.filter((s) => !gone.has(s.endpoint) && (!s.prefs || s.prefs[PREF[a.kind]] !== false) && (!a.pro || pro.has(s.user_id)));
    const ttl = Math.max(60, Math.min(12 * 3600, Math.floor((Date.parse(a.expires) - now) / 1000)));
    const msg = { title: a.title, body: a.body, url: a.url || '/app', tag: a.gid || a.id };
    let ok = 0;
    for (let i = 0; i < to.length; i += BATCH) {
      const st = await Promise.all(to.slice(i, i + BATCH).map((s) => sendPush(env, { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, msg,
        { ttl, urgency: a.kind === 'result' ? 'normal' : 'high', topic: a.gid, auths }).catch(() => 0)));
      st.forEach((code, j) => { if (code >= 200 && code < 300) ok++; else if (code === 404 || code === 410) gone.add(to[i + j].endpoint); });
    }
    await rest(env, `push_sent?id=eq.${encodeURIComponent(a.id)}`, { method: 'PATCH', body: { delivered: ok }, prefer: 'return=minimal' });
    report.push({ id: a.id, to: to.length, ok });
  }
  const custom = ruleDocs.length ? await runCustom(env, feed, ruleDocs, subs, gone, auths, now) : [];
  if (gone.size) await rest(env, `push_subs?endpoint=in.${encodeURIComponent(`(${[...gone].map((e) => `"${e}"`).join(',')})`)}`, { method: 'DELETE' });
  return json({ sent: report, custom, removed: gone.size });
}

const row = (a, delivered) => ({ id: a.id, kind: a.kind, delivered, sent_at: new Date().toISOString(),
  data: { key: a.key, gid: a.gid, line: a.line, pro: !!a.pro, expires: a.expires, url: a.url, pick: a.pick, game: a.game, label: a.label } });

// ---------- custom alerts ----------
// A rule is {id, kind: 'line', gid, side: away|home|over|under, target} (the number reaches target or
// better at any book) or {id, kind: 'move', gid or '*', pts} (a spread or total moved pts or more in
// one check, seen within the last 3 hours). Each fires once per push_sent id; a line rule then gets hit_at.
const sgnPt = (v) => (v === 0 ? 'PK' : (v > 0 ? '+' : '') + v);
const fmtOdds = (o) => (o > 0 ? '+' + o : String(o));
const lastOf = (hist, i) => { for (let k = hist.length - 1; k >= 0; k--) if (hist[k][i] != null) return hist[k][i]; return null; };
function sideNow(L, og, side) {
  const b = og && bestLine(og, side);
  if (b) return { pt: b.line[0], price: b.line[1], book: b.book };
  const sp = lastOf(L.hist, 1), tt = lastOf(L.hist, 2);
  const pt = side === 'away' ? sp : side === 'home' ? (sp == null ? null : -sp) : tt;
  return pt == null ? null : { pt };
}
const sideName = (L, side) => (side === 'away' ? L.away : side === 'home' ? L.home : side === 'over' ? 'Over' : 'Under');
const reached = (side, pt, target) => (side === 'over' ? pt <= target : pt >= target);
async function runCustom(env, feed, docs, subs, gone, auths, now) {
  const lines = feed.lines || {};
  let elite = null;
  if (env.ELITE_ONLY === 'true') {
    const ids = docs.map((d) => d.path.split('/')[2]);
    const b = await rest(env, `billing?select=id,plan,pro_until&id=in.(${ids.join(',')})`).catch(() => []);
    elite = new Set(b.filter((x) => isPro(x) && String(x.plan || '').startsWith('elite')).map((x) => x.id));
  }
  const wantOdds = docs.some((d) => Object.values(d.data.rules).some((r) => r.kind === 'line' && !r.hit_at && lines[r.gid]));
  const odds = wantOdds && env.ODDS_API_KEY ? await getOdds(env, 'nfl').catch(() => null) : null;
  const ogFor = (L) => odds && odds.data && (odds.data.games || []).find((g) => g.away === L.away && g.home === L.home && Math.abs(Date.parse(g.start) - Date.parse(L.ko)) < 12 * 36e5);
  const report = [];
  for (const d of docs) {
    const uid = d.path.split('/')[2];
    if (elite && !elite.has(uid)) continue;
    const to = subs.filter((s) => s.user_id === uid && !gone.has(s.endpoint));
    if (!to.length) continue;
    const rules = { ...d.data.rules };
    let changed = false;
    for (const r of Object.values(rules)) {
      const msgs = [];
      if (r.kind === 'line' && !r.hit_at && lines[r.gid] && typeof r.target === 'number') {
        const L = lines[r.gid], cur = sideNow(L, ogFor(L), r.side);
        if (cur && reached(r.side, cur.pt, r.target)) {
          const nm = sideName(L, r.side), num = r.side === 'over' || r.side === 'under' ? cur.pt : sgnPt(cur.pt);
          msgs.push({ id: `rule:${uid}:${r.id}`, gid: r.gid, ko: L.ko, title: `Your number hit: ${nm} ${num}`,
            body: `${L.away} @ ${L.home}, ${L.when}. ` + (cur.book ? `Best at ${cur.book} (${fmtOdds(cur.price)}). ` : 'From our latest line check, so confirm it at your book. ') + `You asked for ${nm} ${r.side === 'over' || r.side === 'under' ? r.target : sgnPt(r.target)}.` });
          rules[r.id] = { ...r, hit_at: new Date().toISOString() }; changed = true;
        }
      }
      if (r.kind === 'move' && r.pts > 0) for (const gid of r.gid === '*' ? Object.keys(lines) : [r.gid]) {
        const L = lines[gid]; if (!L || L.hist.length < 2) continue;
        const [a, b] = L.hist.slice(-2);
        if (now - Date.parse(b[0]) > 3 * 36e5) continue;
        const ds = a[1] != null && b[1] != null ? Math.abs(b[1] - a[1]) : 0, dt = a[2] != null && b[2] != null ? Math.abs(b[2] - a[2]) : 0;
        if (Math.max(ds, dt) < r.pts) continue;
        const spTxt = (v) => (v === 0 ? 'PK' : v > 0 ? `${L.home} -${v}` : `${L.away} -${-v}`);
        const what = ds >= dt ? `Spread ${spTxt(a[1])} to ${spTxt(b[1])}` : `Total ${a[2]} to ${b[2]}`;
        msgs.push({ id: `rule:${uid}:${r.id}:${gid}:${b[0]}`, gid, ko: L.ko, title: `Fast move: ${L.away} @ ${L.home}`, body: `${what} since our last check. ${L.when}.` });
      }
      for (const m of msgs.slice(0, 5)) {
        const claimed = await rest(env, 'push_sent', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
          body: [{ id: m.id, kind: 'custom', delivered: 0, sent_at: new Date().toISOString(), data: { gid: m.gid, uid } }] }).catch(() => null);
        if (!claimed || !claimed.length) continue;
        const ttl = Math.max(60, Math.min(12 * 3600, Math.floor((Date.parse(m.ko) - now) / 1000)));
        let ok = 0;
        for (const s of to) {
          const code = await sendPush(env, { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, { title: m.title, body: m.body, url: `/app#g_${m.gid}`, tag: m.id },
            { ttl, urgency: 'high', auths }).catch(() => 0);
          if (code >= 200 && code < 300) ok++; else if (code === 404 || code === 410) gone.add(s.endpoint);
        }
        report.push({ id: m.id, ok });
      }
    }
    if (changed) await rest(env, `docs?path=eq.${encodeURIComponent(d.path)}`, { method: 'PATCH', body: { data: { ...d.data, rules } }, prefer: 'return=minimal' }).catch(() => {});
  }
  return report;
}
