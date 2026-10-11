// POST /api/checkout {plan: "monthly" | "yearly"} with the user's Supabase token.
// Returns {url} of a Stripe Checkout page for the Pro subscription; the browser goes there to pay.
import { json, userFrom, billingGet, stripe } from '../../lib/server.js';

export async function onRequestPost({ request, env }) {
  const user = await userFrom(request, env).catch(() => null);
  if (!user) return json({ error: 'sign in required' }, 401);
  const { plan } = await request.json().catch(() => ({}));
  const price = plan === 'yearly' ? env.STRIPE_PRICE_YEARLY : plan === 'monthly' ? env.STRIPE_PRICE_MONTHLY : null;
  if (!price) return json({ error: 'unknown plan' }, 400);
  const origin = new URL(request.url).origin;
  const b = await billingGet(env, user.id).catch(() => null);
  try {
    const s = await stripe(env, 'checkout/sessions', {
      mode: 'subscription',
      line_items: { 0: { price, quantity: 1 } },
      client_reference_id: user.id,
      ...(b && b.stripe_customer ? { customer: b.stripe_customer } : { customer_email: user.email }),
      subscription_data: { metadata: { user_id: user.id, plan } },
      metadata: { user_id: user.id, plan },
      allow_promotion_codes: 'true',
      success_url: `${origin}/app?checkout=done#me`,
      cancel_url: `${origin}/app#me`,
    });
    return json({ url: s.url });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}
