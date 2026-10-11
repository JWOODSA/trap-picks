// POST /api/slip {image: "data:image/jpeg;base64,...", games: [{id, away, home, date}]} with the user's Supabase token.
// Reads a sportsbook bet slip screenshot with Claude and returns the bet as JSON for the user to check before saving.
// Needs the ANTHROPIC_API_KEY secret; SLIP_MODEL overrides the model.
import { json, userFrom } from '../../lib/server.js';

const MAX_B64 = 2_000_000; // the app shrinks screenshots to about 1600px before sending
const TOOL = {
  name: 'bet_slip',
  description: 'The bet shown in the screenshot.',
  input_schema: {
    type: 'object',
    properties: {
      is_bet_slip: { type: 'boolean', description: 'false if the image is not a sportsbook or DFS bet slip / bet history entry' },
      book: { type: ['string', 'null'], description: 'Sportsbook or app, e.g. DraftKings, FanDuel, PrizePicks' },
      stake: { type: ['number', 'null'], description: 'Amount wagered in dollars' },
      odds: { type: ['number', 'null'], description: 'Total American odds of the whole bet, e.g. -110 or +600. If only a payout is shown, convert it.' },
      placed_at: { type: ['string', 'null'], description: 'When the bet was placed, ISO 8601 if shown' },
      status: { type: ['string', 'null'], enum: ['open', 'won', 'lost', 'push', null], description: 'Result if the slip shows one' },
      legs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            game_id: { type: ['string', 'null'], description: 'id from the provided NFL games list when the leg is clearly that game, else null' },
            market: { type: 'string', enum: ['spread', 'total', 'moneyline', 'prop', 'other'] },
            pick: { type: 'string', description: 'spread: "KC -3.5" (team abbreviation from the games list); total: "Over 47.5" or "Under 47.5"; moneyline: "KC ML"; prop or other: short text like "Mahomes Over 274.5 pass yds"' },
            odds: { type: ['number', 'null'], description: 'American odds of this leg if shown' },
          },
          required: ['market', 'pick'],
        },
      },
    },
    required: ['is_bet_slip', 'legs'],
  },
};

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'slip reading is not switched on yet' }, 503);
  const user = await userFrom(request, env).catch(() => null);
  if (!user) return json({ error: 'sign in required' }, 401);
  const body = await request.json().catch(() => ({}));
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.image || '');
  if (!m) return json({ error: 'send a JPEG, PNG or WebP screenshot' }, 400);
  if (m[2].length > MAX_B64) return json({ error: 'image too large' }, 413);
  const games = (Array.isArray(body.games) ? body.games : []).slice(0, 40)
    .filter((g) => g && /^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(g.id))
    .map((g) => `${g.id}: ${g.away} @ ${g.home}${/^\d{4}-\d{2}-\d{2}$/.test(g.date) ? ' on ' + g.date : ''}`);
  const prompt = `Read this bet slip screenshot and record the bet with the bet_slip tool. Copy numbers exactly as shown; use null for anything not visible. One leg per selection.\n\nNFL games this week (match legs to these ids only when the teams clearly match):\n${games.join('\n') || '(none)'}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.SLIP_MODEL || 'claude-haiku-5-5', max_tokens: 1024,
      tools: [TOOL], tool_choice: { type: 'tool', name: 'bet_slip' },
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }, { type: 'text', text: prompt }] }],
    }),
  }).catch(() => null);
  if (!r || !r.ok) return json({ error: 'could not read the slip just now' }, 502);
  const out = await r.json();
  const use = (out.content || []).find((c) => c.type === 'tool_use');
  if (!use) return json({ error: 'could not read the slip' }, 502);
  return json(use.input);
}
