// POST /api/checkout {tier: "pro" | "elite", plan: "monthly" | "yearly"} with the user's Supabase token.
// Returns {url} of a Stripe Checkout page for that subscription; the browser goes there to pay.
// Elite answers 409 "coming soon" until its Stripe prices are set in Cloudflare.
import { json, userFrom, billingGet, stripe, prices, priceFor } from '../../lib/server.js';

export async function onRequestPost({ request, env }) {
  const user = await userFrom(request, env).catch(() => null);
  if (!user) return json({ error: 'sign in required' }, 401);
  const { tier = 'pro', plan: period } = await request.json().catch(() => ({}));
  const plan = `${tier}_${period}`;
  if (!['pro', 'elite'].includes(tier) || !['monthly', 'yearly'].includes(period)) return json({ error: 'unknown plan' }, 400);
  if (!prices(env)[plan]) return json({ error: tier === 'elite' ? 'coming soon' : 'unknown plan' }, tier === 'elite' ? 409 : 400);
  const origin = new URL(request.url).origin;
  const b = await billingGet(env, user.id).catch(() => null);
  try {
    const price = await priceFor(env, prices(env)[plan]);
    if (!price) return json({ error: 'that plan has no price in Stripe' }, 502);
    const s = await stripe(env, 'checkout/sessions', {
      mode: 'subscription',
      line_items: { 0: { price, quantity: 1 } },
      client_reference_id: user.id,
      ...(b && b.stripe_customer ? { customer: b.stripe_customer } : { customer_email: user.email }),
      // First subscription only: TRIAL_DAYS free (default 30), card taken now, first charge when it ends.
      subscription_data: { metadata: { user_id: user.id, plan }, ...(b && b.subscription ? {} : { trial_period_days: +(env.TRIAL_DAYS || 30) }) },
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
