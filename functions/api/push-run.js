// POST /api/push-run: send any alerts in /alerts/alerts.json that have not gone out yet.
// Safe for anyone to call: it only ever sends each alert once (the push_sent row is claimed before
// sending), so the GitHub Action calls it after each data push and on a schedule.
//
// The very first run records every current alert as sent without sending, so turning alerts on
// does not flood phones with the week's backlog. A TRAP or WATCH call that disappears before
// kickoff after it was announced gets one "call pulled" alert.
import { json, rest, isPro } from '../../lib/server.js';
import { sendPush } from '../../lib/webpush.js';

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
  if (!todo.length) return json({ sent: 0 });

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
  if (gone.size) await rest(env, `push_subs?endpoint=in.${encodeURIComponent(`(${[...gone].map((e) => `"${e}"`).join(',')})`)}`, { method: 'DELETE' });
  return json({ sent: report, removed: gone.size });
}

const row = (a, delivered) => ({ id: a.id, kind: a.kind, delivered, sent_at: new Date().toISOString(),
  data: { key: a.key, gid: a.gid, line: a.line, pro: !!a.pro, expires: a.expires, url: a.url, pick: a.pick, game: a.game, label: a.label } });
