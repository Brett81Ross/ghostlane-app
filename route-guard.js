(()=>{
  const VERSION='1.5.0';
  const HARD_AVOID_METERS=150;
  const MAX_SAMPLE_GAP_METERS=20;
  const MAX_DETOUR_REQUESTS=30;
  const DETOUR_RADII_METERS=[1800,3500,6500,10000,16000];
  const DETOUR_BEARINGS=[0,45,90,135,180,225,270,315];

  function cameraKey(cam){return String(cam.node_id||cam.id||`${cam.lat},${cam.lng}`)}
  function denseRoutePoints(route){
    const coords=route?.geometry?.coordinates||[]; if(!coords.length)return [];
    const out=[];
    for(let i=0;i<coords.length-1;i++){
      const a=[coords[i][1],coords[i][0]],b=[coords[i+1][1],coords[i+1][0]];
      const meters=map.distance(a,b),steps=Math.max(1,Math.ceil(meters/MAX_SAMPLE_GAP_METERS));
      for(let s=0;s<steps;s++){const t=s/steps;out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t])}
    }
    const last=coords[coords.length-1];out.push([last[1],last[0]]);return out;
  }
  function auditRoute(route){
    const points=denseRoutePoints(route),hitMap=new Map();let nearest=Infinity;
    for(const pt of points){for(const cam of cameraLocations||[]){
      const lat=+cam.lat,lng=+cam.lng;if(!Number.isFinite(lat)||!Number.isFinite(lng))continue;
      const d=map.distance(pt,[lat,lng]);if(d<nearest)nearest=d;
      if(d<=HARD_AVOID_METERS){const key=cameraKey(cam),prior=hitMap.get(key);if(!prior||d<prior.distance)hitMap.set(key,{camera:cam,distance:d})}
    }}
    const hits=[...hitMap.values()].sort((a,b)=>a.distance-b.distance);
    return {clear:hits.length===0,hits,nearest,pointsChecked:points.length};
  }
  function clearExistingRoute(){
    if(routePolyline){try{map.removeLayer(routePolyline)}catch(_){} routePolyline=null}
    routeSteps=[];currentStepIdx=0;const hud=document.getElementById('turn-hud');if(hud)hud.style.display='none';
  }
  function destinationPoint(lat,lng,bearingDeg,distanceM){
    const R=6371000,br=bearingDeg*Math.PI/180,p1=lat*Math.PI/180,l1=lng*Math.PI/180,d=distanceM/R;
    const p2=Math.asin(Math.sin(p1)*Math.cos(d)+Math.cos(p1)*Math.sin(d)*Math.cos(br));
    const l2=l1+Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(p1),Math.cos(d)-Math.sin(p1)*Math.sin(p2));
    return [p2*180/Math.PI,((l2*180/Math.PI+540)%360)-180];
  }
  async function fetchJson(url,ms=12000){
    const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);
    try{const r=await fetch(url,{signal:c.signal,headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json()}finally{clearTimeout(t)}
  }
  async function requestRoutes(points,alternatives=true){
    const coords=points.map(p=>`${p[1]},${p[0]}`).join(';');
    const url=`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&alternatives=${alternatives?'true':'false'}`;
    const data=await fetchJson(url,14000);return data.routes||[];
  }
  function rankAudited(items){return items.sort((a,b)=>a.audit.hits.length-b.audit.hits.length||b.audit.nearest-a.audit.nearest||(a.route.distance||Infinity)-(b.route.distance||Infinity))}
  async function findClearRoute(start,dest){
    let requests=0;const tested=[];
    const base=await requestRoutes([start,dest],true);requests++;
    for(const r of base)tested.push({route:r,audit:auditRoute(r),via:[]});
    let clear=tested.filter(x=>x.audit.clear).sort((a,b)=>(a.route.distance||Infinity)-(b.route.distance||Infinity));
    if(clear.length)return {best:clear[0],requests,tested};

    let frontier=rankAudited([...tested]).slice(0,3);
    for(let depth=0;depth<3 && requests<MAX_DETOUR_REQUESTS;depth++){
      const next=[];
      for(const candidate of frontier){
        const blockers=candidate.audit.hits.slice(0,Math.min(3,candidate.audit.hits.length));
        for(const blocker of blockers){
          const cam=blocker.camera,lat=+cam.lat,lng=+cam.lng;
          for(const radius of DETOUR_RADII_METERS){
            for(const bearing of DETOUR_BEARINGS){
              if(requests>=MAX_DETOUR_REQUESTS)break;
              const wp=destinationPoint(lat,lng,bearing,radius);
              const via=[...(candidate.via||[]),wp];
              try{
                const routes=await requestRoutes([start,...via,dest],false);requests++;
                for(const r of routes){
                  const item={route:r,audit:auditRoute(r),via};tested.push(item);
                  if(item.audit.clear)return {best:item,requests,tested};
                  next.push(item);
                }
              }catch(e){requests++;console.debug('[GhostLane] detour candidate failed',e.message)}
            }
            if(requests>=MAX_DETOUR_REQUESTS)break;
          }
          if(requests>=MAX_DETOUR_REQUESTS)break;
        }
        if(requests>=MAX_DETOUR_REQUESTS)break;
      }
      frontier=rankAudited(next).slice(0,4);
      if(!frontier.length)break;
    }
    clear=tested.filter(x=>x.audit.clear).sort((a,b)=>(a.route.distance||Infinity)-(b.route.distance||Infinity));
    return {best:clear[0]||null,requests,tested};
  }
  function instructionFor(step){return step?.maneuver?.instruction||(step?.name?`Proceed onto ${step.name}`:'Proceed along Shadow Vector')}
  async function strictCameraFreeSearch(){
    const query=document.getElementById('dest-address')?.value?.trim();if(!query)return;
    closeSearch();clearExistingRoute();
    if(!Array.isArray(cameraLocations)||cameraLocations.length===0){if(typeof showHudModal==='function')showHudModal('Camera Mesh Not Ready','GhostLane will not calculate a Shadow Route until camera intelligence is loaded. Wait a moment and try again.',{tone:'danger'});return}
    if(typeof showHudToast==='function')showHudToast(`Zero-camera search • willing to take major detours around ${cameraLocations.length} mapped nodes…`);
    if(typeof speakAlert==='function')speakAlert('Calculating strict zero camera route. Detours allowed.');
    try{
      const nom=await fetchJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`);
      if(!nom.length)throw new Error('Destination not found.');
      const dest=[+nom[0].lat,+nom[0].lon],start=[+userCoords[0],+userCoords[1]];
      const result=await findClearRoute(start,dest);
      if(!result.best){
        clearExistingRoute();
        const least=rankAudited(result.tested)[0],count=least?.audit?.hits?.length||0;
        const msg=`GhostLane searched ${result.requests} route/detour candidates and still could not verify a route outside every ${HARD_AVOID_METERS} m camera exclusion zone${count?`. The best remaining candidate still intersects ${count} mapped camera zone${count===1?'':'s'}`:''}. Navigation was not started.`;
        if(typeof showHudModal==='function')showHudModal('Zero-Camera Route Not Verified',msg,{tone:'danger'});
        if(typeof speakAlert==='function')speakAlert('Zero camera route could not be verified. Navigation blocked.');return;
      }
      const best=result.best,r=best.route,latlngs=r.geometry.coordinates.map(p=>[p[1],p[0]]);
      routePolyline=L.polyline(latlngs,{color:'#38bdf8',weight:6,dashArray:'8, 8'}).addTo(map);map.fitBounds(routePolyline.getBounds(),{padding:[60,60]});
      routeSteps=(r.legs||[]).flatMap(l=>l.steps||[]);currentStepIdx=0;
      if(routeSteps.length){const hud=document.getElementById('turn-hud');if(hud)hud.style.display='flex';updateTurnHUD(routeSteps[0])}
      const miles=((r.distance||0)/1609.344).toFixed(1),minutes=Math.round((r.duration||0)/60),nearestFeet=Number.isFinite(best.audit.nearest)?Math.round(best.audit.nearest*3.28084):null;
      if(typeof showHudToast==='function')showHudToast(`ZERO-CAMERA ROUTE VERIFIED • ${miles} mi • ~${minutes} min • ${result.requests} candidates checked${nearestFeet?` • nearest mapped camera ~${nearestFeet} ft`:''}`);
      if(typeof speakAlert==='function')speakAlert('Zero camera route verified. Major detours are allowed to preserve the exclusion zone.');
      if(routeSteps[0]&&typeof speakAlert==='function')setTimeout(()=>speakAlert(instructionFor(routeSteps[0])),900);
      console.info('[GhostLane] aggressive zero-camera route accepted',{version:VERSION,requests:result.requests,via:best.via,audit:best.audit,distance:r.distance,duration:r.duration});
    }catch(err){clearExistingRoute();console.error('[GhostLane] strict route failed',err);if(typeof showHudModal==='function')showHudModal('Route Unavailable',err.message||'GhostLane could not calculate a camera-free route.',{tone:'danger'})}
  }
  window.executeSearch=strictCameraFreeSearch;
  console.info(`[GhostLane] aggressive zero-camera Shadow Route ${VERSION} active • hard exclusion ${HARD_AVOID_METERS}m • major detours allowed`);
})();