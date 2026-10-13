// Push alert sign-ups. Works signed in or not; a signed-in Pro member also gets the Pro alerts.
//   GET    /api/push                          {key}: the public key the browser subscribes with
//   POST   /api/push {subscription, prefs}    save or update this device (prefs: {calls, moves, results})
//   POST   /api/push?test=1 {subscription}    send this device a test alert right now
//   DELETE /api/push {endpoint}               forget this device
import { json, userFrom, rest } from '../../lib/server.js';
import { pushHostOk, sendPush } from '../../lib/webpush.js';

const ready = (env) => env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY;
const PREFS = ['calls', 'moves', 'results'];

export async function onRequestGet({ env }) {
  return json({ key: ready(env) ? env.VAPID_PUBLIC_KEY : null });
}

export async function onRequestPost({ request, env }) {
  if (!ready(env)) return json({ error: 'alerts are not set up yet' }, 503);
  const { subscription: s, prefs } = await request.json().catch(() => ({}));
  if (!s || !pushHostOk(s.endpoint) || !s.keys || !/^[\w-]{80,100}$/.test(s.keys.p256dh || '') || !/^[\w-]{16,32}$/.test(s.keys.auth || '')) return json({ error: 'bad subscription' }, 400);
  if (new URL(request.url).searchParams.get('test')) {
    const st = await sendPush(env, s, { title: 'Trap Picks alerts are on', body: 'You will hear about new calls, line moves and results here.', url: '/app' }, { ttl: 600 }).catch(() => 0);
    return json({ ok: st >= 200 && st < 300, status: st });
  }
  const user = await userFrom(request, env).catch(() => null);
  const p = Object.fromEntries(PREFS.map((k) => [k, !prefs || prefs[k] !== false]));
  await rest(env, 'push_subs', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
    body: { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, user_id: user ? user.id : null, prefs: p, updated_at: new Date().toISOString() } });
  return json({ ok: true, prefs: p, pro_alerts: !!user });
}

export async function onRequestDelete({ request, env }) {
  if (!ready(env)) return json({ ok: true });
  const { endpoint } = await request.json().catch(() => ({}));
  if (endpoint) await rest(env, `push_subs?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE' });
  return json({ ok: true });
}
