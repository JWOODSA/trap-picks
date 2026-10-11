// Kickoff forecast relay for the Trap Picks app (Cloudflare Pages Function).
// GET /api/weather?lat=41.86&lon=-87.62&at=2026-10-11T17:00:00Z returns the hourly
// forecast closest to kickoff from Open-Meteo (free, no key): temperature (F),
// wind and gusts (mph) and chance of rain. Cached at the edge for 30 minutes.
const TTL = 1800;

export async function onRequestGet({ request, waitUntil }) {
  const u = new URL(request.url);
  const lat = Number(u.searchParams.get('lat')), lon = Number(u.searchParams.get('lon'));
  const at = Date.parse(u.searchParams.get('at') || '');
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !Number.isFinite(at)) {
    return json({ error: 'need lat, lon and at' }, 400);
  }
  const hour = new Date(Math.round(at / 3600e3) * 3600e3).toISOString().slice(0, 13);
  const key = new Request(new URL(`/api/weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&h=${hour}`, request.url).toString());
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  const q = new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lon.toFixed(3), timezone: 'UTC', forecast_days: '16',
    hourly: 'temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability',
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph',
  });
  let d;
  try {
    const up = await fetch('https://api.open-meteo.com/v1/forecast?' + q, { headers: { accept: 'application/json' } });
    if (!up.ok) return json({ error: `forecast unavailable (${up.status})` }, 502);
    d = await up.json();
  } catch (e) {
    return json({ error: 'forecast unavailable' }, 502);
  }
  const times = (d.hourly && d.hourly.time) || [];
  const i = times.indexOf(hour + ':00');
  if (i < 0) return json({ error: 'kickoff is outside the forecast window' }, 404);
  const H = d.hourly;
  const body = { at: times[i] + 'Z', temp: H.temperature_2m[i], wind: H.wind_speed_10m[i], gust: H.wind_gusts_10m[i],
    rain: H.precipitation_probability[i], source: 'Open-Meteo', fetched: new Date().toISOString() };
  const res = new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${TTL}` },
  });
  waitUntil(cache.put(key, res.clone()));
  return res;
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
