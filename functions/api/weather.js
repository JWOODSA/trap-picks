// Kickoff forecast relay for the Trap Picks app.
// GET /api/weather?lat=41.86&lon=-87.62&at=2026-10-11T17:00:00Z returns the forecast for the kickoff hour
// from the National Weather Service (api.weather.gov: free, no key, US government data, fine for commercial
// use): temperature (F), wind and gusts (mph) with direction, chance of rain, rain amount (inches) and a
// WMO-style weather code (clear, cloudy, fog, rain, snow, storms) so the app's drawing code stays the same.
// The NWS covers the US only and about 7 days ahead. Cached at the edge for 30 minutes.
const TTL = 1800;
const UA = 'trap-picks.com (https://trap-picks.com)';   // the NWS asks every caller to identify itself

export async function onRequestGet({ request, waitUntil }) {
  const u = new URL(request.url);
  const lat = Number(u.searchParams.get('lat')), lon = Number(u.searchParams.get('lon'));
  const at = Date.parse(u.searchParams.get('at') || '');
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !Number.isFinite(at)) {
    return json({ error: 'need lat, lon and at' }, 400);
  }
  const hour = Math.round(at / 3600e3) * 3600e3;
  const key = new Request(new URL(`/api/weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&h=${new Date(hour).toISOString().slice(0, 13)}&src=nws`, request.url).toString());
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  let d;
  try {
    const get = (url) => fetch(url, { headers: { accept: 'application/geo+json', 'user-agent': UA } });
    const pt = await get(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
    if (pt.status === 404) return json({ error: 'no forecast outside the US' }, 404);
    if (!pt.ok) return json({ error: `forecast unavailable (${pt.status})` }, 502);
    const grid = (await pt.json()).properties?.forecastGridData;
    if (!grid) return json({ error: 'no forecast outside the US' }, 404);
    const up = await get(grid);
    if (!up.ok) return json({ error: `forecast unavailable (${up.status})` }, 502);
    d = (await up.json()).properties || {};
  } catch (e) {
    return json({ error: 'forecast unavailable' }, 502);
  }
  const body = pick(d, hour);
  if (!body) return json({ error: 'kickoff is outside the forecast window' }, 404);
  const res = new Response(JSON.stringify({ ...body, at: new Date(hour).toISOString(), source: 'National Weather Service', fetched: new Date().toISOString() }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${TTL}` },
  });
  waitUntil(cache.put(key, res.clone()));
  return res;
}

// NWS grid data: each field is {uom, values: [{validTime: '2026-10-21T06:00:00+00:00/PT2H', value}]}.
// Find the value whose time span covers the kickoff hour, converted to the units the app uses.
export function pick(p, hour) {
  const at = (f) => {
    for (const v of (p[f] && p[f].values) || []) {
      const [start, dur] = String(v.validTime).split('/'), t0 = Date.parse(start);
      if (Number.isFinite(t0) && hour >= t0 && hour < t0 + span(dur)) return v.value;
    }
    return undefined;
  };
  const uom = (f) => (p[f] && p[f].uom) || '';
  const tempC = at('temperature');
  if (tempC == null) return null;
  const temp = /degF/.test(uom('temperature')) ? tempC : tempC * 9 / 5 + 32;
  const wind = mph(at('windSpeed'), uom('windSpeed')), gust = mph(at('windGust'), uom('windGust'));
  const rain = at('probabilityOfPrecipitation') ?? 0;
  const q = at('quantitativePrecipitation'), qi = q == null ? null : /mm/.test(uom('quantitativePrecipitation')) ? q / 25.4 : q;
  return { temp, wind: wind ?? 0, gust: Math.max(gust ?? 0, wind ?? 0), dir: at('windDirection') ?? null, rain,
    precip: qi, code: code(at('weather'), at('skyCover')) };
}

// ISO 8601 durations like PT1H, PT6H, P1D, P1DT12H.
function span(dur) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(dur || '');
  return m ? ((+m[1] || 0) * 24 + (+m[2] || 0) + (+m[3] || 0) / 60) * 3600e3 : 3600e3;
}
function mph(v, unit) {
  if (v == null) return null;
  return /km_h/.test(unit) ? v / 1.609344 : /m_s/.test(unit) ? v * 2.236936 : /kn/.test(unit) ? v * 1.150779 : v;
}
// NWS weather list -> the WMO code ranges the app already sorts on.
function code(wx, sky) {
  const kinds = (wx || []).map((w) => (w && w.weather) || '').join(' ');
  if (/thunder/.test(kinds)) return 95;
  if (/snow|sleet|ice_pellets|blowing_snow/.test(kinds)) return 73;
  if (/freezing/.test(kinds)) return 66;
  if (/rain|drizzle|showers/.test(kinds)) return /showers/.test(kinds) ? 80 : /drizzle/.test(kinds) ? 51 : 61;
  if (/fog/.test(kinds)) return 45;
  return sky == null ? 2 : sky < 25 ? 0 : sky < 50 ? 1 : sky < 85 ? 2 : 3;
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
