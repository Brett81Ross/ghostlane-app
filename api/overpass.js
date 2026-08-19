const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter'
];

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function buildQuery(action, body) {
  if (action === 'scan') {
    const lat = clampNumber(body.lat, -90, 90, null);
    const lng = clampNumber(body.lng, -180, 180, null);
    const radius = Math.round(clampNumber(body.radius, 250, 40000, 16093));
    if (lat === null || lng === null) throw new Error('Invalid scan coordinates.');
    return `[out:json][timeout:25];(nwr["man_made"="surveillance"](around:${radius},${lat},${lng});nwr["highway"="speed_camera"](around:${radius},${lat},${lng}););out center tags;`;
  }

  if (action === 'roads') {
    const lat = clampNumber(body.lat, -90, 90, null);
    const lng = clampNumber(body.lng, -180, 180, null);
    const radius = Math.round(clampNumber(body.radius, 25, 300, 100));
    if (lat === null || lng === null) throw new Error('Invalid roadway coordinates.');
    return `[out:json][timeout:20];way["highway"](around:${radius},${lat},${lng});out geom;`;
  }

  throw new Error('Unsupported Overpass action.');
}

async function queryEndpoint(endpoint, query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Accept': 'application/json',
        'User-Agent': 'GhostLane/1.0 camera-mesh utility'
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required.' });

  let query;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    query = buildQuery(body.action, body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const failures = [];
  for (let pass = 0; pass < 2; pass++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const data = await queryEndpoint(endpoint, query);
        return res.status(200).json({ elements: data.elements || [], endpoint });
      } catch (error) {
        failures.push(`${endpoint}: ${error.name === 'AbortError' ? 'timeout' : error.message}`);
      }
    }
  }

  return res.status(502).json({ error: 'Public map servers are temporarily unavailable.', failures });
};
