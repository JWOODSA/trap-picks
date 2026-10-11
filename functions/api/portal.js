// POST /api/portal with the user's Supabase token. Returns {url} of Stripe's billing page, where
// subscribers change their card, switch monthly/yearly, see receipts or cancel.
import { json, userFrom, billingGet, stripe } from '../../lib/server.js';

export async function onRequestPost({ request, env }) {
  const user = await userFrom(request, env).catch(() => null);
  if (!user) return json({ error: 'sign in required' }, 401);
  const b = await billingGet(env, user.id).catch(() => null);
  if (!b || !b.stripe_customer) return json({ error: 'no subscription yet' }, 404);
  try {
    const s = await stripe(env, 'billing_portal/sessions', { customer: b.stripe_customer, return_url: `${new URL(request.url).origin}/app#me` });
    return json({ url: s.url });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}
