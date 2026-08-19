(()=>{
  const DEDUPE_METERS=22;
  const OKC=[35.20,-97.85,35.75,-97.20];
  const layer=L.layerGroup().addTo(map);
  let mesh=[];
  const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const inOKC=(lat,lng)=>lat>=OKC[0]&&lat<=OKC[2]&&lng>=OKC[1]&&lng<=OKC[3];
  const dist=(a,b)=>map.distance([a.lat,a.lng],[b.lat,b.lng]);
  function normalize(f){
    const p=f.properties||{},c=f.geometry&&f.geometry.coordinates;
    if(!c||c.length<2)return null;
    const lat=+c[1],lng=+c[0]; if(!Number.isFinite(lat)||!Number.isFinite(lng)||!inOKC(lat,lng))return null;
    const tags=p.tags||p;
    const vendor=tags.manufacturer||tags.brand||tags.operator||tags['surveillance:type']||'Public map';
    const type=tags['camera:type']||tags.surveillance||tags['surveillance:zone']||'ALPR / surveillance camera';
    const heading=+(tags.direction||tags.heading);
    return {lat,lng,id:String(p.id||tags.id||`PUB-${lat.toFixed(5)}-${lng.toFixed(5)}`),heading:Number.isFinite(heading)?heading:0,label:String(vendor),type:String(type),source:'DeFlock / OpenStreetMap',confidence:'community',_publicMesh:true};
  }
  function addUnique(n){if(!n)return false;const existing=cameraLocations.find(c=>dist(c,n)<=DEDUPE_METERS);if(existing){existing._sources=[...new Set([...(existing._sources||[]),n.source])];return false}cameraLocations.push(n);mesh.push(n);return true}
  function popup(n){return `<div class="node-popup-title">${safe(n.label)}</div><div class="node-popup-type">${safe(n.type)}</div><div class="node-popup-meta"><span>Source: ${safe(n.source)}</span><span>Confidence: COMMUNITY MAPPED</span></div><div class="node-popup-hint">Public/crowdsourced location • may be incomplete or stale</div>`}
  async function load(){
    try{
      const res=await fetch('https://data.dontgetflocked.com/cameras.geojson.gz',{cache:'no-store'});
      if(!res.ok)throw new Error(`HTTP ${res.status}`);
      const data=await res.json();
      let added=0;
      (data.features||[]).forEach(f=>{if(addUnique(normalize(f)))added++});
      if(typeof renderCameras==='function')renderCameras();
      // Rebind public-mesh popups with provenance after the core renderer runs.
      cameraLayerGroup.eachLayer(m=>{const ll=m.getLatLng&&m.getLatLng();if(!ll)return;const n=mesh.find(x=>map.distance(ll,[x.lat,x.lng])<2);if(n)m.bindPopup(popup(n),{closeButton:true,maxWidth:260})});
      if(typeof showHudToast==='function')showHudToast(`Multi-Source Mesh • ${added} OKC-area sourced nodes added`);
      console.info('[GhostLane] multi-source mesh',added,'added',mesh.length,'public nodes');
    }catch(e){
      console.warn('[GhostLane] public mesh load failed',e);
      if(typeof showHudToast==='function')showHudToast('Public camera mesh unavailable • cloud/manual nodes remain active','orange');
    }
  }
  load();
})();