// Pro-only files under /pro/ (the full board with this week's calls). The request must carry the
// signed-in user's Supabase token, and that user must have an active Pro subscription.
import { json, userFrom, billingGet, isPro } from '../../lib/server.js';

export async function onRequest({ request, env, next }) {
  const user = await userFrom(request, env).catch(() => null);
  if (!user) return json({ error: 'sign in required' }, 401);
  const b = await billingGet(env, user.id).catch(() => null);
  if (!isPro(b)) return json({ error: 'Pro required' }, 402);
  const res = await next();
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'private, no-store');
  return out;
}
