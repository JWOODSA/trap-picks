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
const svc = (env) => ({ apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` });

export const isPro = (b) => !!(b && b.pro_until && Date.parse(b.pro_until) > Date.now());

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
