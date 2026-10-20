// Shared helpers for the Pages Functions: who is calling (Supabase sign-in), their Pro status,
// and small Stripe and JSON helpers. Secrets come from the Cloudflare project's environment variables.

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}

// The signed-in user for a request carrying "Authorization: Bearer <Supabase access token>", or null.
export async function userFrom(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ') || !env.SUPABASE_URL) return null;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

// Read and write the billing table with the service role key (bypasses row security; server only).
export async function billingGet(env, id) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/billing?id=eq.${encodeURIComponent(id)}&select=*`, { headers: svc(env) });
  if (!r.ok) throw new Error(`billing read ${r.status}`);
  return (await r.json())[0] || null;
}
export async function billingByCustomer(env, customer) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/billing?stripe_customer=eq.${encodeURIComponent(customer)}&select=*`, { headers: svc(env) });
  if (!r.ok) throw new Error(`billing read ${r.status}`);
  return (await r.json())[0] || null;
}
export async function billingPut(env, row) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/billing`, {
    method: 'POST', headers: { ...svc(env), 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`billing write ${r.status} ${await r.text()}`);
}
// Works with the legacy service_role key (a JWT, also sent as Bearer) or a new sb_secret_ key (apikey header only).
const svc = (env) => { const k = env.SUPABASE_SERVICE_ROLE_KEY; return k.startsWith('sb_') ? { apikey: k } : { apikey: k, authorization: `Bearer ${k}` }; };

// Tiers: Pro ($9.99/mo, $59/yr) and Elite ($19.99/mo, $149/yr). Elite includes everything in Pro.
// billing.plan is pro_monthly, pro_yearly, elite_monthly or elite_yearly (older rows: monthly, yearly = Pro).
export const isPro = (b) => !!(b && b.pro_until && Date.parse(b.pro_until) > Date.now());
export const isElite = (b) => isPro(b) && String(b.plan || '').startsWith('elite');
export function prices(env) {
  return { pro_monthly: env.STRIPE_PRICE_MONTHLY, pro_yearly: env.STRIPE_PRICE_YEARLY,
    elite_monthly: env.STRIPE_PRICE_ELITE_MONTHLY, elite_yearly: env.STRIPE_PRICE_ELITE_YEARLY };
}
// The plan a Stripe subscription is on, from its price (so plan switches in Stripe's billing page count).
export function planOf(env, sub) {
  const price = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price;
  const id = price && (price.id || price), prod = price && (price.product && (price.product.id || price.product));
  // Each setting may be a price ID (price_) or a product ID (prod_) whose default price is used.
  const hit = Object.entries(prices(env)).find(([, v]) => v && (v === id || v === prod));
  if (hit) return hit[0];
  const m = (sub.metadata || {}).plan;
  return m === 'monthly' || m === 'yearly' ? 'pro_' + m : m || null;
}

// The price to charge for a setting: a price_ ID as is, or a product's default price for a prod_ ID.
export async function priceFor(env, v) {
  if (!v || !v.startsWith('prod_')) return v;
  const p = await stripe(env, `products/${v}`, null, 'GET');
  return p.default_price && (p.default_price.id || p.default_price);
}

// Stripe's REST API takes form-encoded bodies; nested keys use brackets, e.g. line_items[0][price].
export async function stripe(env, path, params, method = 'POST') {
  const body = new URLSearchParams();
  const add = (k, v) => { if (v == null) return; if (typeof v === 'object') for (const [kk, vv] of Object.entries(v)) add(`${k}[${kk}]`, vv); else body.append(k, String(v)); };
  for (const [k, v] of Object.entries(params || {})) add(k, v);
  const r = await fetch(`https://api.stripe.com/v1/${path}${method === 'GET' && params ? '?' + body : ''}`, {
    method, headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: method === 'POST' ? body : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error((d.error && d.error.message) || `stripe ${r.status}`);
  return d;
}

// Check a Stripe webhook signature (header "Stripe-Signature: t=...,v1=...") against the raw body.
export async function stripeVerify(payload, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries((header || '').split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }).filter(([k]) => k));
  const sigs = (header || '').split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => s.length === hex.length && [...s].reduce((a, c, i) => a | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}

// Supabase REST call with the service role key (server only). path is under /rest/v1/.
export async function rest(env, path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method, headers: { ...svc(env), ...(body ? { 'content-type': 'application/json' } : {}), ...(prefer ? { prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path.split('?')[0]} ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}
