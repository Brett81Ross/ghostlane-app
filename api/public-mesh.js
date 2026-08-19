const zlib = require('zlib');

const SOURCE_URL = 'https://data.dontgetflocked.com/cameras.geojson.gz';
const OKC = { minLat: 35.20, minLng: -97.85, maxLat: 35.75, maxLng: -97.20 };

function inOkc(lat, lng) {
  return lat >= OKC.minLat && lat <= OKC.maxLat && lng >= OKC.minLng && lng <= OKC.maxLng;
}

function normalizeFeature(feature) {
  const props = feature && feature.properties ? feature.properties : {};
  const coords = feature && feature.geometry ? feature.geometry.coordinates : null;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inOkc(lat, lng)) return null;

  const tags = props.tags || props;
  const rawHeading = Number(tags.direction ?? tags.heading);
  return {
    lat,
    lng,
    id: String(props.id || tags.id || `PUB-${lat.toFixed(5)}-${lng.toFixed(5)}`),
    heading: Number.isFinite(rawHeading) ? rawHeading : 0,
    label: String(tags.manufacturer || tags.brand || tags.operator || tags['surveillance:type'] || 'Public map'),
    type: String(tags['camera:type'] || tags.surveillance || tags['surveillance:zone'] || 'ALPR / surveillance camera'),
    source: 'DeFlock / OpenStreetMap',
    confidence: 'community'
  };
}

function parseBody(buffer) {
  let data = buffer;
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    data = zlib.gunzipSync(buffer);
  }
  return JSON.parse(data.toString('utf8'));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET required.' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const upstream = await fetch(SOURCE_URL, {
      headers: {
        'Accept': 'application/json, application/gzip, */*',
        'User-Agent': 'GhostLane/1.3.4 public-camera-mesh'
      },
      signal: controller.signal
    });
    if (!upstream.ok) throw new Error(`Upstream HTTP ${upstream.status}`);

    const raw = Buffer.from(await upstream.arrayBuffer());
    const geojson = parseBody(raw);
    const nodes = [];
    for (const feature of geojson.features || []) {
      const node = normalizeFeature(feature);
      if (node) nodes.push(node);
    }

    return res.status(200).json({
      nodes,
      count: nodes.length,
      source: 'DeFlock / OpenStreetMap',
      region: 'Oklahoma City metro',
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    const message = error && error.name === 'AbortError' ? 'Public camera source timed out.' : (error.message || 'Public camera source unavailable.');
    return res.status(502).json({ error: message });
  } finally {
    clearTimeout(timer);
  }
};
