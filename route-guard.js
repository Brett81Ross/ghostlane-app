(()=>{
  const VERSION='1.6.0';
  const MAX_SAMPLE_GAP_METERS=10;
  const REQUEST_TIMEOUT_MS=7000;
  const MAX_CANDIDATES=24;
  const DETOUR_RADII_METERS=[500,1000,2000,4000,8000,14000,22000];
  const DETOUR_BEARINGS=[0,45,90,135,180,225,270,315];

  function cameraKey(cam){return String(cam.node_id||cam.id||`${cam.lat},${cam.lng}`)}
  function isRouteBlocking(cam){if(cam.routeBlocking===false)return false;return !['red-light','speed','traffic'].includes(cam.category)}
  function exclusionMeters(cam){const text=`${cam.label||''} ${cam.type||''} ${cam.source||''}`.toLowerCase();if(/falcon\s*lr|long[- ]?range|\blr\b/.test(text))return 50;if(/falcon\s*sr|short[- ]?range|\bsr\b/.test(text))return 22;if(/flock|alpr|lpr|license plate|plate reader/.test(text))return 35;return 30}
  function denseRoutePoints(route){const coords=route?.geometry?.coordinates||[];if(!coords.length)return[];const out=[];for(let i=0;i<coords.length-1;i++){const a=[coords[i][1],coords[i][0]],b=[coords[i+1][1],coords[i+1][0]],meters=map.distance(a,b),steps=Math.max(1,Math.ceil(meters/MAX_SAMPLE_GAP_METERS));for(let s=0;s<steps;s++){const t=s/steps;out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t])}}const last=coords[coords.length-1];out.push([last[1],last[0]]);return out}
  function auditRoute(route){const points=denseRoutePoints(route),hitMap=new Map();let nearest=Infinity;for(const pt of points){for(const cam of cameraLocations||[]){if(!isRouteBlocking(cam))continue;const lat=+cam.lat,lng=+cam.lng;if(!Number.isFinite(lat)||!Number.isFinite(lng))continue;const d=map.distance(pt,[lat,lng]);if(d<nearest)nearest=d;const limit=exclusionMeters(cam);if(d<=limit){const key=cameraKey(cam),prior=hitMap.get(key);if(!prior||d<prior.distance)hitMap.set(key,{camera:cam,distance:d,exclusion:limit})}}}return{clear:hitMap.size===0,hits:[...hitMap.values()].sort((a,b)=>a.distance-b.distance),nearest,pointsChecked:points.length}}
  function clearExistingRoute(){if(routePolyline){try{map.removeLayer(routePolyline)}catch(_){}routePolyline=null}routeSteps=[];currentStepIdx=0;const hud=document.getElementById('turn-hud');if(hud)hud.style.display='none'}
  function destinationPoint(lat,lng,bearingDeg,distanceM){const R=6371000,br=bearingDeg*Math.PI/180,p1=lat*Math.PI/180,l1=lng*Math.PI/180,d=distanceM/R,p2=Math.asin(Math.sin(p1)*Math.cos(d)+Math.cos(p1)*Math.sin(d)*Math.cos(br)),l2=l1+Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(p1),Math.cos(d)-Math.sin(p1)*Math.sin(p2));return[p2*180/Math.PI,((l2*180/Math.PI+540)%360)-180]}
  async function fetchJson(url,ms=REQUEST_TIMEOUT_MS){const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{signal:c.signal,headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json()}finally{clearTimeout(t)}}
  async function requestRoutes(points,alternatives=true){const coords=points.map(p=>`${p[1]},${p[0]}`).join(';'),url=`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&alternatives=${alternatives?'true':'false'}`;const data=await fetchJson(url);return data.routes||[]}
  async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(next<items.length){const i=next++;try{out[i]=await fn(items[i],i)}catch(e){out[i]=null}}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out}
  function progress(text){if(typeof showHudToast==='function')showHudToast(text)}

  async function findClearRoute(start,dest){
    const tested=[];
    progress('Checking direct Shadow Route alternatives…');
    const base=await requestRoutes([start,dest],true);
    for(const r of base){const item={route:r,audit:auditRoute(r),via:[]};tested.push(item);if(item.audit.clear)return{best:item,checked:tested.length}}
    if(!tested.length)return{best:null,checked:0};

    const blockers=[];const seen=new Set();
    for(const item of tested.sort((a,b)=>a.audit.hits.length-b.audit.hits.length)){for(const hit of item.audit.hits){const k=cameraKey(hit.camera);if(!seen.has(k)){seen.add(k);blockers.push(hit.camera)}if(blockers.length>=4)break}if(blockers.length>=4)break}
    const candidates=[];
    for(const cam of blockers){for(const radius of DETOUR_RADII_METERS){for(const bearing of DETOUR_BEARINGS){candidates.push(destinationPoint(+cam.lat,+cam.lng,bearing,radius));if(candidates.length>=MAX_CANDIDATES)break}if(candidates.length>=MAX_CANDIDATES)break}if(candidates.length>=MAX_CANDIDATES)break}

    progress(`Searching ${candidates.length} wide detours…`);
    let checked=tested.length;
    const results=await mapLimit(candidates,4,async(wp)=>{
      const routes=await requestRoutes([start,wp,dest],false);checked++;
      if(checked%4===0)progress(`Shadow Route search • ${checked} candidates checked`);
      if(!routes.length)return null;
      const item={route:routes[0],audit:auditRoute(routes[0]),via:[wp]};tested.push(item);return item;
    });
    const clear=results.filter(Boolean).filter(x=>x.audit.clear).sort((a,b)=>(a.route.distance||Infinity)-(b.route.distance||Infinity));
    if(clear.length)return{best:clear[0],checked};

    const leastBlocked=tested.filter(x=>x.route).sort((a,b)=>a.audit.hits.length-b.audit.hits.length||b.audit.nearest-a.audit.nearest)[0];
    if(leastBlocked?.audit?.hits?.length){const pivot=leastBlocked.audit.hits[0].camera;const second=[];for(const radius of [6000,12000,20000,30000])for(const bearing of DETOUR_BEARINGS)second.push(destinationPoint(+pivot.lat,+pivot.lng,bearing,radius));progress('Expanding Shadow Route search farther out…');const more=await mapLimit(second.slice(0,16),4,async(wp)=>{const routes=await requestRoutes([start,wp,dest],false);checked++;if(!routes.length)return null;const item={route:routes[0],audit:auditRoute(routes[0]),via:[wp]};tested.push(item);return item});const clear2=more.filter(Boolean).filter(x=>x.audit.clear).sort((a,b)=>(a.route.distance||Infinity)-(b.route.distance||Infinity));if(clear2.length)return{best:clear2[0],checked}}
    return{best:null,checked};
  }

  async function strictCameraFreeSearch(){
    const query=document.getElementById('dest-address')?.value?.trim();if(!query)return;
    closeSearch();clearExistingRoute();
    const blocking=(cameraLocations||[]).filter(isRouteBlocking);
    if(!blocking.length){if(typeof showHudModal==='function')showHudModal('Camera Mesh Not Ready','GhostLane will not calculate a Shadow Route until surveillance intelligence is loaded. Wait a moment and try again.',{tone:'danger'});return}
    progress(`Shadow Route • ${blocking.length} surveillance nodes loaded`);
    try{
      const nom=await fetchJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`,7000);
      if(!nom.length)throw new Error('Destination not found.');
      if(!Array.isArray(userCoords)||!Number.isFinite(+userCoords[0])||!Number.isFinite(+userCoords[1]))throw new Error('Current GPS location is not ready yet.');
      const dest=[+nom[0].lat,+nom[0].lon],start=[+userCoords[0],+userCoords[1]],result=await findClearRoute(start,dest);
      if(!result.best){clearExistingRoute();if(typeof showHudModal==='function')showHudModal('No Verified Zero-Camera Route',`GhostLane checked ${result.checked} direct and wide-detour routes but could not verify one that stays outside every mapped Flock/ALPR/surveillance detection zone. Try again in a moment as routing servers or camera data update.`,{tone:'danger'});return}
      const r=result.best.route,latlngs=r.geometry.coordinates.map(p=>[p[1],p[0]]);routePolyline=L.polyline(latlngs,{color:'#38bdf8',weight:6,dashArray:'8, 8'}).addTo(map);map.fitBounds(routePolyline.getBounds(),{padding:[60,60]});routeSteps=(r.legs||[]).flatMap(l=>l.steps||[]);currentStepIdx=0;if(routeSteps.length){const hud=document.getElementById('turn-hud');if(hud)hud.style.display='flex';updateTurnHUD(routeSteps[0])}const miles=((r.distance||0)/1609.344).toFixed(1),minutes=Math.round((r.duration||0)/60);progress(`ZERO-CAMERA ROUTE VERIFIED • ${miles} mi • ~${minutes} min • ${result.checked} checked`)
    }catch(err){clearExistingRoute();const msg=err?.name==='AbortError'?'Routing service timed out. Please try again.':(err.message||'GhostLane could not calculate a surveillance-free route.');if(typeof showHudModal==='function')showHudModal('Route Unavailable',msg,{tone:'danger'})}
  }
  window.executeSearch=strictCameraFreeSearch;
})();