(()=>{
  const DEDUPE_METERS=22;
  let mesh=[];
  const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dist=(a,b)=>map.distance([a.lat,a.lng],[b.lat,b.lng]);
  const COLORS={alpr:'#ef4444',surveillance:'#f97316','red-light':'#eab308',speed:'#a855f7',traffic:'#38bdf8'};
  const LABELS={alpr:'FLOCK / ALPR',surveillance:'SURVEILLANCE','red-light':'RED-LIGHT',speed:'SPEED',traffic:'TRAFFIC'};
  const LOCKED=new Set(['alpr','surveillance']);
  const visibility={alpr:true,surveillance:true,'red-light':true,speed:true,traffic:true};

  function keyFor(n){return String(n.id||n.node_id||`${n.lat},${n.lng}`)}
  function classify(n){
    if(n.category&&COLORS[n.category])return n.category;
    const t=`${n.label||''} ${n.type||''} ${n.source||''}`.toLowerCase();
    if(/flock|alpr|license\s*plate|plate\s*reader|\blpr\b/.test(t))return'alpr';
    if(/red[- ]?light/.test(t))return'red-light';
    if(/speed camera|speed enforcement/.test(t))return'speed';
    if(/traffic camera|traffic enforcement/.test(t))return'traffic';
    return'surveillance';
  }
  function headingInfo(n){
    const raw=n.heading??n.direction??n.camera_direction??n['camera:direction'];
    const num=Number(raw);
    if(n.headingKnown===false)return{heading:Number.isFinite(num)?((num%360)+360)%360:0,known:false};
    if(Number.isFinite(num))return{heading:((num%360)+360)%360,known:n.headingKnown!==false};
    const mapDir={N:0,NE:45,E:90,SE:135,S:180,SW:225,W:270,NW:315};
    const k=String(raw||'').trim().toUpperCase();
    if(Object.prototype.hasOwnProperty.call(mapDir,k))return{heading:mapDir[k],known:true};
    return{heading:0,known:false};
  }
  function coneHtml(color,heading,known){
    const cone=(deg,opacity=1)=>`<span style="position:absolute;left:20px;top:18px;width:0;height:0;border-top:11px solid transparent;border-bottom:11px solid transparent;border-left:34px solid ${color};filter:drop-shadow(0 0 5px ${color});opacity:${opacity};transform-origin:-20px 11px;transform:rotate(${deg-90}deg)"></span>`;
    if(known)return cone(heading,.78);
    return `${cone(0,.18)}${cone(90,.18)}${cone(180,.18)}${cone(270,.18)}`;
  }
  function iconFor(n){
    const cat=classify(n),c=COLORS[cat],dir=headingInfo(n),unknown=dir.known?'':'?';
    return L.divIcon({className:'gl-category-camera',html:`<div style="position:relative;width:72px;height:58px;overflow:visible"><div style="position:absolute;left:24px;top:17px;width:25px;height:25px;border-radius:50%;background:${c};border:2px solid #fff;box-shadow:0 0 13px ${c};z-index:3;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:900">${unknown||'●'}</div>${coneHtml(c,dir.heading,dir.known)}</div>`,iconSize:[72,58],iconAnchor:[36,29],popupAnchor:[0,-18]});
  }
  function addUnique(n){
    if(!n||!Number.isFinite(+n.lat)||!Number.isFinite(+n.lng))return false;
    const normalized={...n,lat:+n.lat,lng:+n.lng,category:classify(n),_publicMesh:true};
    const existing=cameraLocations.find(c=>dist(c,normalized)<=DEDUPE_METERS);
    if(existing){
      existing._sources=[...new Set([...(existing._sources||[]),...(normalized.sources||[normalized.source||'Public Mesh'])])];
      if(!existing.category)existing.category=normalized.category;
      if(existing.routeBlocking==null)existing.routeBlocking=normalized.routeBlocking;
      if(headingInfo(existing).known===false&&headingInfo(normalized).known){existing.heading=normalized.heading;existing.headingKnown=true;}
      normalized._linkedExisting=existing;mesh.push(normalized);return false;
    }
    cameraLocations.push(normalized);mesh.push(normalized);return true;
  }
  function popup(n){
    const sources=(n.sources&&n.sources.length?n.sources:[n.source||'GhostLane']).join(' + '),cat=classify(n),dir=headingInfo(n);
    const direction=dir.known?`${Math.round(dir.heading)}°`:'UNKNOWN / NOT MAPPED';
    return `<div class="node-popup-title">${safe(n.label||'Camera')}</div><div class="node-popup-type" style="color:${COLORS[cat]}">${safe(LABELS[cat])} • ${safe(n.type||'Camera')}</div><div class="node-popup-meta"><span>Source: ${safe(sources)}</span><span>Direction: ${safe(direction)}</span><span>Routing: ${n.routeBlocking===false?'INFORMATIONAL ONLY':'AVOIDANCE ACTIVE'}</span></div><div class="node-popup-hint">Solid cone = mapped direction. Four faint cones + ? = direction not available from the source.</div>`;
  }
  function applyMarkerVisibility(marker,cat){const on=LOCKED.has(cat)?true:visibility[cat]!==false;if(marker.setOpacity)marker.setOpacity(on?1:0);const el=marker.getElement&&marker.getElement();if(el){el.style.pointerEvents=on?'auto':'none';el.style.display=on?'':'none'}}
  function normalizeAll(){
    for(const n of cameraLocations||[]){n.category=classify(n);if(n.routeBlocking==null)n.routeBlocking=n.category==='alpr'||n.category==='surveillance';}
  }
  function restyleAll(){
    normalizeAll();
    cameraLayerGroup.eachLayer(m=>{
      const ll=m.getLatLng&&m.getLatLng();if(!ll)return;
      const n=(cameraLocations||[]).find(x=>map.distance(ll,[+x.lat,+x.lng])<2);if(!n)return;
      const cat=classify(n);m._ghostlaneCategory=cat;if(m.setIcon)m.setIcon(iconFor(n));m.bindPopup(popup(n),{closeButton:true,maxWidth:300});applyMarkerVisibility(m,cat);
    });
  }
  function applyAll(){cameraLayerGroup.eachLayer(m=>{if(m._ghostlaneCategory)applyMarkerVisibility(m,m._ghostlaneCategory)})}
  function controls(){
    if(document.getElementById('gl-camera-controls'))return;
    const wrap=document.createElement('div');wrap.id='gl-camera-controls';wrap.style.cssText='position:absolute;left:10px;bottom:12px;z-index:1001;background:rgba(8,13,26,.94);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:9px 10px;width:148px;color:#cbd5e1;font-size:9px;font-weight:800;line-height:1.45;box-shadow:0 6px 20px rgba(0,0,0,.45);backdrop-filter:blur(6px)';
    wrap.innerHTML=`<div style="font-size:9px;color:#f8fafc;letter-spacing:.7px;margin-bottom:5px">CAMERA LAYERS</div>${Object.keys(LABELS).map(cat=>{const locked=LOCKED.has(cat);return `<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:3px 0"><span><span style="color:${COLORS[cat]}">●</span> ${LABELS[cat]}${locked?' 🔒':''}</span><input type="checkbox" data-gl-cat="${cat}" ${locked?'checked disabled':'checked'} style="accent-color:${COLORS[cat]};width:14px;height:14px"></label>`}).join('')}<div style="font-size:7px;color:#64748b;margin-top:5px;line-height:1.3">Flock/ALPR + surveillance stay ON. Every visible camera shows a direction indicator.</div>`;
    document.getElementById('map-wrapper')?.appendChild(wrap);
    try{const saved=JSON.parse(localStorage.getItem('gl-camera-layers')||'{}');['red-light','speed','traffic'].forEach(cat=>{if(typeof saved[cat]==='boolean'){visibility[cat]=saved[cat];const i=wrap.querySelector(`[data-gl-cat="${cat}"]`);if(i)i.checked=saved[cat]}})}catch(_){}
    wrap.querySelectorAll('input[data-gl-cat]:not(:disabled)').forEach(input=>input.addEventListener('change',()=>{visibility[input.dataset.glCat]=input.checked;applyAll();localStorage.setItem('gl-camera-layers',JSON.stringify(visibility))}));
  }
  async function load(){
    try{
      const res=await fetch('/api/public-mesh',{cache:'no-store',headers:{Accept:'application/json'}}),data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);
      let added=0;(data.nodes||[]).forEach(n=>{if(addUnique(n))added++});
      if(typeof renderCameras==='function')renderCameras();
      restyleAll();controls();applyAll();
      if(typeof showHudToast==='function')showHudToast(`Camera mesh updated • ${added} nodes • cones applied to all visible cameras`);
      window.GhostLanePublicMeshStatus={added,total:data.count,categories:data.categories||{},sources:data.sources||[],partial:!!data.partial,failures:data.failures||[]};
      console.info('[GhostLane] all-camera direction display active',window.GhostLanePublicMeshStatus);
    }catch(e){
      console.warn('[GhostLane] public mesh load failed',e);
      normalizeAll();if(typeof renderCameras==='function')renderCameras();restyleAll();controls();applyAll();
      window.GhostLanePublicMeshStatus={added:0,total:0,sources:[],partial:true,failures:[e.message]};
    }
  }
  load();
})();