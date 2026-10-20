// Cloudflare Worker entry: serves public/ as static assets and routes /api, /pro and /alerts
// to the same handlers in functions/ (written in the Pages Functions style, so either host works).
import * as live from './functions/api/live/[league].js';
import * as weather from './functions/api/weather.js';
import * as checkout from './functions/api/checkout.js';
import * as portal from './functions/api/portal.js';
import * as webhook from './functions/api/stripe-webhook.js';
import * as slip from './functions/api/slip.js';
import * as push from './functions/api/push.js';
import * as pushRun from './functions/api/push-run.js';
import * as oddsApi from './functions/api/odds.js';
import * as injuries from './functions/api/injuries.js';
import * as rankings from './functions/api/rankings.js';
import { scheduledOdds, scheduledProps } from './lib/odds.js';
import * as pro from './functions/pro/_middleware.js';
import * as hidden from './functions/alerts/_middleware.js';

const API = { weather, checkout, portal, 'stripe-webhook': webhook, slip, push, 'push-run': pushRun, odds: oddsApi, injuries, rankings };

// Pages Functions export onRequest or onRequest<Method>; pick the one for this request.
function pick(mod, method) {
  const m = method[0] + method.slice(1).toLowerCase();
  return mod['onRequest' + m] || mod.onRequest || null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const assets = () => env.ASSETS.fetch(request);
    const call = (mod, params = {}) => {
      const fn = pick(mod, request.method);
      if (!fn) return new Response('Method not allowed', { status: 405 });
      return fn({ request, env, params, next: assets, waitUntil: (p) => ctx.waitUntil(p), data: {} });
    };
    if (parts[0] === 'alerts') return call(hidden);
    if (parts[0] === 'pro') return call(pro);
    if (parts[0] === 'api') {
      if (parts[1] === 'live' && parts[2]) return call(live, { league: parts[2] });
      const mod = API[parts[1]];
      if (mod && parts.length === 2) return call(mod);
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return assets();
  },
  // Timed jobs (crons in wrangler.jsonc): college sportsbook lines and closing lines.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledOdds(env).then((r) => console.log('scheduledOdds', JSON.stringify(r))).catch((e) => console.log('scheduledOdds failed', e.message)));
    ctx.waitUntil(scheduledProps(env).then((r) => console.log('scheduledProps', JSON.stringify(r))).catch((e) => console.log('scheduledProps failed', e.message)));
  },
};
