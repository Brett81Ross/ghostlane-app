const zlib = require('zlib');

const OKC = { minLat: 35.15, minLng: -97.95, maxLat: 35.85, maxLng: -97.05 };
const DEFLOCK_SOURCES = [
  'https://data.dontgetflocked.com/cameras.geojson.gz',
  'https://data.dontgetflocked.com/cameras.geojson'
];
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter'
];

function inOkc(lat, lng) {
  return lat >= OKC.minLat && lat <= OKC.maxLat && lng >= OKC.minLng && lng <= OKC.maxLng;
}
function headingValue(v){
  const n=Number(v); if(Number.isFinite(n)) return ((n%360)+360)%360;
  const m={N:0,NE:45,E:90,SE:135,S:180,SW:225,W:270,NW:315};
  return m[String(v||'').trim().toUpperCase().split(';')[0]] ?? 0;
}
function normalizeGeoFeature(feature, source='DeFlock / OpenStreetMap') {
  const props = feature && feature.properties ? feature.properties : {};
  const coords = feature && feature.geometry ? feature.geometry.coordinates : null;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]), lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inOkc(lat, lng)) return null;
  const tags = props.tags || props;
  const surveillanceType = tags['surveillance:type'] || tags['camera:type'] || tags.surveillance || tags['surveillance:zone'];
  const label = tags.manufacturer || tags.brand || tags.operator || tags.name || (String(surveillanceType||'').toUpperCase()==='ALPR'?'ALPR Camera':'Public Surveillance Camera');
  return {
    lat,lng,
    id:String(props.id || tags.id || `PUB-${lat.toFixed(6)}-${lng.toFixed(6)}`),
    heading:headingValue(tags.direction ?? tags['camera:direction'] ?? tags.heading),
    label:String(label).slice(0,180),
    type:String(surveillanceType || (tags.highway==='speed_camera'?'Speed Camera':'Surveillance Camera')).slice(0,180),
    source,
    confidence:'community'
  };
}
function parseBody(buffer) {
  let data = buffer;
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) data = zlib.gunzipSync(buffer);
  return JSON.parse(data.toString('utf8'));
}
async function fetchWithTimeout(url, options={}, ms=14000){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),ms);
  try{return await fetch(url,{...options,signal:controller.signal})} finally {clearTimeout(timer)}
}
async function fetchDeflock(){
  const failures=[];
  for(const url of DEFLOCK_SOURCES){
    try{
      const upstream=await fetchWithTimeout(url,{headers:{'Accept':'application/json, application/geo+json, application/gzip, */*','User-Agent':'GhostLane/1.4.0 public-camera-mesh'}},14000);
      if(!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      const raw=Buffer.from(await upstream.arrayBuffer());
      const geojson=parseBody(raw), nodes=[];
      for(const feature of geojson.features||[]){const n=normalizeGeoFeature(feature,'DeFlock / OpenStreetMap');if(n)nodes.push(n)}
      return {nodes,source:'DeFlock / OpenStreetMap'};
    }catch(e){failures.push(`${url}: ${e.name==='AbortError'?'timeout':e.message}`)}
  }
  throw new Error(`DeFlock unavailable (${failures.join(' | ')})`);
}
function overpassQuery(){
  const b=`${OKC.minLat},${OKC.minLng},${OKC.maxLat},${OKC.maxLng}`;
  return `[out:json][timeout:20];(nwr["man_made"="surveillance"](${b});nwr["surveillance:type"="ALPR"](${b});nwr["highway"="speed_camera"](${b});nwr["enforcement"="traffic_signals"](${b});nwr["enforcement"="speed"](${b}););out center tags;`;
}
function normalizeOverpass(e){
  const p=(Number.isFinite(e.lat)&&Number.isFinite(e.lon))?{lat:e.lat,lng:e.lon}:(e.center&&Number.isFinite(e.center.lat)&&Number.isFinite(e.center.lon)?{lat:e.center.lat,lng:e.center.lon}:null);
  if(!p||!inOkc(p.lat,p.lng))return null;
  const t=e.tags||{};
  const st=t['surveillance:type']||t['camera:type']||t.surveillance||t.enforcement;
  const isAlpr=String(st||'').toUpperCase()==='ALPR';
  return {lat:+p.lat,lng:+p.lng,id:`OSM-${e.type}-${e.id}`,heading:headingValue(t.direction??t['camera:direction']),label:String(t.manufacturer||t.brand||t.operator||t.name||(isAlpr?'ALPR Camera':t.highway==='speed_camera'?'Speed Camera':t.enforcement?'Traffic Enforcement Camera':'Surveillance Camera')).slice(0,180),type:String(st||(t.highway==='speed_camera'?'Speed Camera':'Surveillance Camera')).slice(0,180),source:'OpenStreetMap / Overpass',confidence:'community'};
}
async function fetchOverpass(){
  const query=overpassQuery(), failures=[];
  for(const endpoint of OVERPASS_ENDPOINTS){
    try{
      const r=await fetchWithTimeout(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'application/json','User-Agent':'GhostLane/1.4.0 camera-mesh'},body:`data=${encodeURIComponent(query)}`},15000);
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const data=await r.json();
      return {nodes:(data.elements||[]).map(normalizeOverpass).filter(Boolean),source:'OpenStreetMap / Overpass'};
    }catch(e){failures.push(`${endpoint}: ${e.name==='AbortError'?'timeout':e.message}`)}
  }
  throw new Error(`Overpass unavailable (${failures.join(' | ')})`);
}
function metersBetween(a,b){
  const R=6371000,p1=a.lat*Math.PI/180,p2=b.lat*Math.PI/180,dp=(b.lat-a.lat)*Math.PI/180,dl=(b.lng-a.lng)*Math.PI/180;
  const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*R*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
}
function mergeNodes(groups){
  const out=[];
  for(const group of groups){for(const n of group.nodes||[]){
    const hit=out.find(x=>metersBetween(x,n)<=18);
    if(hit){hit.sources=[...new Set([...(hit.sources||[hit.source]),n.source])]; if(!hit.label&&n.label)hit.label=n.label; continue;}
    out.push({...n,sources:[n.source]});
  }}
  return out;
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET required.' });
  const settled=await Promise.allSettled([fetchDeflock(),fetchOverpass()]);
  const groups=settled.filter(x=>x.status==='fulfilled').map(x=>x.value);
  const failures=settled.filter(x=>x.status==='rejected').map(x=>x.reason?.message||'Unknown source failure');
  if(!groups.length)return res.status(502).json({error:'All public camera sources are temporarily unavailable.',failures});
  const nodes=mergeNodes(groups);
  return res.status(200).json({nodes,count:nodes.length,region:'Oklahoma City metro',sources:groups.map(g=>({name:g.source,count:g.nodes.length})),partial:failures.length>0,failures,generatedAt:new Date().toISOString()});
};