(()=>{
  const DEDUPE_METERS=22;
  const layer=L.layerGroup().addTo(map);
  let mesh=[];
  const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dist=(a,b)=>map.distance([a.lat,a.lng],[b.lat,b.lng]);

  function addUnique(n){
    if(!n||!Number.isFinite(+n.lat)||!Number.isFinite(+n.lng))return false;
    const normalized={...n,lat:+n.lat,lng:+n.lng,heading:Number.isFinite(+n.heading)?+n.heading:0,_publicMesh:true};
    const existing=cameraLocations.find(c=>dist(c,normalized)<=DEDUPE_METERS);
    if(existing){
      existing._sources=[...new Set([...(existing._sources||[]),normalized.source||'Public Mesh'])];
      return false;
    }
    cameraLocations.push(normalized);
    mesh.push(normalized);
    return true;
  }

  function popup(n){
    return `<div class="node-popup-title">${safe(n.label||'Public camera')}</div><div class="node-popup-type">${safe(n.type||'ALPR / surveillance camera')}</div><div class="node-popup-meta"><span>Source: ${safe(n.source||'Public Mesh')}</span><span>Confidence: COMMUNITY MAPPED</span></div><div class="node-popup-hint">Public/crowdsourced location • may be incomplete or stale</div>`;
  }

  function rebindPublicPopups(){
    cameraLayerGroup.eachLayer(m=>{
      const ll=m.getLatLng&&m.getLatLng();
      if(!ll)return;
      const n=mesh.find(x=>map.distance(ll,[x.lat,x.lng])<2);
      if(n)m.bindPopup(popup(n),{closeButton:true,maxWidth:260});
    });
  }

  async function load(){
    try{
      const res=await fetch('/api/public-mesh',{cache:'no-store',headers:{'Accept':'application/json'}});
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);
      let added=0;
      (data.nodes||[]).forEach(n=>{if(addUnique(n))added++});
      if(typeof renderCameras==='function')renderCameras();
      rebindPublicPopups();
      if(typeof showHudToast==='function')showHudToast(`Multi-Source Mesh • ${added} OKC-area sourced nodes added`);
      console.info('[GhostLane] server public mesh',added,'added',mesh.length,'public nodes');
    }catch(e){
      console.warn('[GhostLane] public mesh load failed',e);
      if(typeof showHudToast==='function')showHudToast('Public camera mesh temporarily unavailable • cloud/manual nodes remain active','orange');
    }
  }
  load();
})();