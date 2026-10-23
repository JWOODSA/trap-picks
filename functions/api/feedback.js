// In-app feedback. POST /api/feedback {kind: bug|idea|other, message, page, sport, version} saves one
// row in the Supabase feedback table (service role; the table has no public access). A signed-in
// caller's account id and email go with it so the team can reply. Light limit: 5 notes per 10 minutes per IP.
import { json, userFrom } from '../../lib/server.js';

const KINDS = new Set(['bug', 'idea', 'other']);
const LIMIT = 5, WINDOW = 600;

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'feedback is not set up' }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
  const message = String((b && b.message) || '').trim().slice(0, 2000);
  if (message.length < 3) return json({ error: 'message is too short' }, 400);
  const kind = KINDS.has(b.kind) ? b.kind : 'other';
  const clip = (v, n) => String(v || '').slice(0, n);

  // Rate limit through the edge cache: one counter per IP per 10-minute window.
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const slot = Math.floor(Date.now() / 1000 / WINDOW);
  const key = new Request(`https://trap-picks.internal/feedback-limit/${encodeURIComponent(ip)}/${slot}`);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const seen = cache ? Number(await (await cache.match(key))?.text() || 0) : 0;
  if (seen >= LIMIT) return json({ error: 'too many notes, try again later' }, 429);
  if (cache) await cache.put(key, new Response(String(seen + 1), { headers: { 'cache-control': `max-age=${WINDOW}` } }));

  const user = await userFrom(request, env).catch(() => null);
  const k = env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/feedback`, {
    method: 'POST',
    headers: { apikey: k, ...(k.startsWith('sb_') ? {} : { authorization: `Bearer ${k}` }), 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({ kind, message, page: clip(b.page, 80), sport: clip(b.sport, 12), app_build: clip(b.version, 40),
      user_id: user ? user.id : null, email: user ? clip(user.email, 200) : null, user_agent: clip(request.headers.get('user-agent'), 300) }),
  });
  if (!r.ok) return json({ error: 'could not save' }, 502);
  return json({ ok: true });
}
