# Trap Picks website (Cloudflare Workers)

`worker.js` serves `public/` as static files and sends `/api/*`, `/pro/*` and `/alerts/*` to the handlers in `functions/` (Pages Functions style, so the site also runs on Cloudflare Pages unchanged). `wrangler.jsonc` is the Worker config; Workers Builds deploys every push to main with `npx wrangler deploy`.

- `public/index.html` is the home page (from `web/landing.html`). `public/app.html` is the app, served at `/app`. Data files sit next to them.
- `functions/api/live/[league].js` relays ESPN live scores (`/api/live/nfl`, `/api/live/nba`), cached 15 seconds.
- `functions/api/weather.js` relays the free Open-Meteo forecast: `/api/weather?lat=..&lon=..&at=<kickoff ISO>` returns temperature, wind, gusts, direction, rain chance, rain amount and weather code for the kickoff hour, cached 30 minutes.
- Accounts: Supabase (Google, or a one-tap email link). `supabase/schema.sql` creates the tables and access rules.
- Pro: Stripe subscriptions. `functions/api/checkout.js` opens Stripe Checkout, `functions/api/portal.js` opens Stripe's billing page, `functions/api/stripe-webhook.js` keeps each member's Pro status current, and `functions/pro/_middleware.js` serves `/pro/core.json` (this week's calls) only to Pro members.
- Install and alerts: `public/manifest.webmanifest`, `public/icons/` and `public/sw.js` make the app installable (iPhone: Share, Add to Home Screen). The Alerts card on My Picks turns on push alerts: new TRAP calls, line moves on them (a point, or onto, off or across 3 or 7), calls pulled before kickoff, and results. `functions/api/push.js` saves each phone, `functions/api/push-run.js` sends from `public/alerts/alerts.json` (never served; Pro-only alerts go only to Pro members when the paywall is on), and `.github/workflows/push-alerts.yml` calls it after each data push and every hour. `lib/webpush.js` does the Web Push encryption and signing with no packages.
- Rebuild `public/` with `web/build_web.sh` in the project after `export_app.py` and `export_fantasy.py`. Settings that are safe to publish go in `web/config.json`: `supabase_url`, `supabase_anon_key`, and `paywall` (true removes this week's calls from the public file).

## One-time setup

1. **Cloudflare**: Workers & Pages, Create, Import a repository, pick this repo. Build command empty, deploy command `npx wrangler deploy` (the default). The Worker must be named `trap-picks` to match `wrangler.jsonc`.
2. **Supabase** (supabase.com, free): new project. SQL Editor: paste `supabase/schema.sql`, Run.
   - Authentication, URL Configuration: Site URL `https://<your site>`; add `https://<your site>/app` to Redirect URLs.
   - Authentication, Providers: Email on. Google on, with a Google OAuth client (Google Cloud console, APIs & Services, Credentials, OAuth client ID, Web; authorized redirect URI is the callback URL Supabase shows).
3. **Stripe** (stripe.com): product "Trap Picks Pro" with a $9.99 monthly price and a $59 yearly price.
   - Developers, Webhooks, Add endpoint: `https://<your site>/api/stripe-webhook`, events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
   - Settings, Billing, Customer portal: turn on cancel and switch plans.
4. **Cloudflare environment variables** (the trap-picks Worker, Settings, Variables and Secrets; mark the secret ones as Secret):
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (secret)
   - `STRIPE_SECRET_KEY` (secret), `STRIPE_WEBHOOK_SECRET` (secret)
   - `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY` (the price_ IDs)
   - `ANTHROPIC_API_KEY` (secret, from console.anthropic.com): turns on bet slip screenshot upload (`/api/slip`). Optional `SLIP_MODEL` overrides the model. Without it the app says upload is coming soon.
5. **Push alerts**: open `https://<your site>/setup-alerts.html` once. It makes the keys in your browser. Add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (secret) and `VAPID_SUBJECT` (mailto: your email) to the Cloudflare variables. In GitHub (Settings, Secrets and variables, Actions, Variables) add `SITE_URL`, for example `https://trappicks.pages.dev`. The first send records the current alerts without sending them, so nobody gets a backlog.
6. Put the Supabase URL and anon key in `web/config.json`, set `paywall` to true when checkout works, rebuild and push.

Stripe rule to keep: selling sports information is allowed, but sports forecasting, fantasy sports or contests with a cash or prize payout are prohibited. Pick'em and fantasy leagues must never pay prizes.

## Local test

    npx wrangler dev
