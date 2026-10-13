// POST /api/stripe-webhook, called by Stripe (not the app). Keeps billing.pro_until in step with the
// subscription: paid or trialing means Pro until the end of the current period; canceled or unpaid
// ends it. Add this URL in Stripe: Developers, Webhooks, with the events listed in web/README.md.
import { json, stripe, stripeVerify, billingPut, billingByCustomer, planOf } from '../../lib/server.js';

const ACTIVE = new Set(['active', 'trialing', 'past_due']);   // past_due: Stripe is still retrying the card

export async function onRequestPost({ request, env }) {
  const payload = await request.text();
  if (!(await stripeVerify(payload, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) return json({ error: 'bad signature' }, 400);
  const ev = JSON.parse(payload);
  const o = ev.data && ev.data.object;
  try {
    if (ev.type === 'checkout.session.completed' && o.mode === 'subscription') {
      const sub = await stripe(env, `subscriptions/${o.subscription}`, null, 'GET');
      await save(env, o.client_reference_id || (o.metadata || {}).user_id, sub);
    } else if (ev.type.startsWith('customer.subscription.')) {
      let uid = (o.metadata || {}).user_id;
      if (!uid) { const b = await billingByCustomer(env, o.customer); uid = b && b.id; }
      if (uid) await save(env, uid, o);
    }
    return json({ received: true });
  } catch (e) {
    return json({ error: e.message }, 500);   // Stripe retries failed deliveries
  }
}

async function save(env, uid, sub) {
  if (!uid) return;
  // Newer Stripe API versions keep the period end on the subscription item.
  const end = sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end);
  const on = ACTIVE.has(sub.status) && end;
  await billingPut(env, {
    id: uid, stripe_customer: sub.customer, subscription: sub.id, status: sub.status, plan: planOf(env, sub),
    pro_until: on ? new Date(end * 1000).toISOString() : new Date().toISOString(),
  });
}
