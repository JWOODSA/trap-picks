# Trap Picks web host (Cloudflare Pages)

The public site. Same app page as the Claude artifact, plus a live-score relay.

- `public/` is the site: index.html, core.json, players.json, fantasy.json. Rebuild it with `web/build_web.sh` after `export_app.py` and `export_fantasy.py`.
- `functions/api/live/[league].js` is a Pages Function. `/api/live/nfl` and `/api/live/nba` return ESPN's free scoreboard, cached 15 seconds at the edge. The page sets `window.TRAP_API = "/api"` so it reads scores through the relay (Claude artifacts block direct requests to ESPN).
- `functions/api/weather.js` relays the free Open-Meteo forecast: `/api/weather?lat=..&lon=..&at=<kickoff ISO>` returns temperature, wind, gusts and chance of rain for the kickoff hour, cached 30 minutes. Game pages for open-air stadiums show it.
- Accounts (picks, groups, fantasy leagues) still run only inside the Claude artifact. On the web host they show "coming soon" until Supabase sign-in is added.

## One-time setup

1. Push this `web/` folder as the root of a GitHub repo.
2. Cloudflare dashboard: Workers & Pages, Create, Pages, Connect to Git, pick the repo.
   Framework preset: None. Build command: leave empty. Build output directory: `public`.
3. Deploy. The site is live at `<project>.pages.dev`; add a custom domain later under the project's Custom domains tab.

Every push to the repo redeploys automatically.

## Local test

    npx wrangler pages dev public --compatibility-date=2024-09-23
