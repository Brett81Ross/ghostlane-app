(()=>{
  const VERSION='1.6.8';
  const REQUEST_TIMEOUT_MS=9000;
  const MAX_DETOUR_METERS=804672;
  const DETOUR_BEARINGS=[0,45,90,135,180,225,270,315];
  const TARGET_RADII=[120,220,400,700,1200,2000,3500,6000,10000,16000,26000,42000];
  const REGIONAL_RADII=[80000,120000,180000,260000,400000,600000,804672];

  function cameraKey(cam){return String(cam.node_id||cam.id||`${cam.lat},${cam.lng}`)}
  function isRouteBlocking(cam){if(cam.routeBlocking===false)return false;return !['red-light','speed','traffic'].includes(cam.category)}
  function exclusionMeters(cam){const text=`${cam.label||''} ${cam.type||''} ${cam.source||''}`.toLowerCase();if(/falcon\s*lr|long[- ]?range|\blr\b/.test(text))return 50;if(/falcon\s*sr|short[- ]?range|\bsr\b/.test(text))return 22;if(/flock|alpr|lpr|license plate|plate reader/.test(text))return 35;return 30}
  function clearExistingRoute(){if(routePolyline){try{map.removeLayer(routePolyline)}catch(_){}routePolyline=null}routeSteps=[];currentStepIdx=0;const hud=document.getElementById('turn-hud');if(hud)hud.style.display='none'}
  function destinationPoint(lat,lng,bearingDeg,distanceM){const R=6371000,br=bearingDeg*Math.PI/180,p1=lat*Math.PI/180,l1=lng*Math.PI/180,d=distanceM/R,p2=Math.asin(Math.sin(p1)*Math.cos(d)+Math.cos(p1)*Math.sin(d)*Math.cos(br)),l2=l1+Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(p1),Math.cos(d)-Math.sin(p1)*Math.sin(p2));return[p2*180/Math.PI,((l2*180/Math.PI+540)%360)-180]}
  function midpoint(a,b){return[(a[0]+b[0])/2,(a[1]+b[1])/2]}
  function bearing(a,b){const p1=a[0]*Math.PI/180,p2=b[0]*Math.PI/180,dl=(b[1]-a[1])*Math.PI/180,y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);return( Math.atan2(y,x)*180/Math.PI+360)%360}
  async function fetchJson(url,ms=REQUEST_TIMEOUT_MS){const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{signal:c.signal,headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json()}finally{clearTimeout(t)}}
  async function requestRoutes(points,alternatives=true){const coords=points.map(p=>`${p[1]},${p[0]}`).join(';'),url=`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&alternatives=${alternatives?'true':'false'}`;const data=await fetchJson(url);return data.routes||[]}
  async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(next<items.length){const i=next++;try{out[i]=await fn(items[i],i)}catch(e){out[i]=null}await new Promise(r=>setTimeout(r,0))}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out}
  function progress(text){if(typeof showHudToast==='function')showHudToast(text)}
  function bestClear(items){return items.filter(Boolean).filter(x=>x.audit?.clear).sort((a,b)=>(a.route.distance||Infinity)-(b.route.distance||Infinity))[0]||null}
  function leastBlocked(items){return items.filter(Boolean).filter(x=>x.route).sort((a,b)=>a.audit.hits.length-b.audit.hits.length||b.audit.nearest-a.audit.nearest||(a.route.distance||Infinity)-(b.route.distance||Infinity))[0]||null}

  function pointToSegmentMeters(pLat,pLng,aLat,aLng,bLat,bLng){
    const lat0=pLat*Math.PI/180,mx=111320*Math.cos(lat0),my=110540;
    const ax=(aLng-pLng)*mx,ay=(aLat-pLat)*my,bx=(bLng-pLng)*mx,by=(bLat-pLat)*my,vx=bx-ax,vy=by-ay,len2=vx*vx+vy*vy;
    let t=len2>0?(-(ax*vx+ay*vy))/len2:0;t=Math.max(0,Math.min(1,t));return Math.hypot(ax+t*vx,ay+t*vy);
  }

  function auditRoute(route){
    const coords=route?.geometry?.coordinates||[];if(coords.length<2)return{clear:false,hits:[],nearest:0};
    let minLat=Infinity,maxLat=-Infinity,minLng=Infinity,maxLng=-Infinity;
    for(const c of coords){const lng=+c[0],lat=+c[1];if(lat<minLat)minLat=lat;if(lat>maxLat)maxLat=lat;if(lng<minLng)minLng=lng;if(lng>maxLng)maxLng=lng}
    const pad=.0012,cams=(cameraLocations||[]).filter(cam=>{if(!isRouteBlocking(cam))return false;const lat=+cam.lat,lng=+cam.lng;return Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=minLat-pad&&lat<=maxLat+pad&&lng>=minLng-pad&&lng<=maxLng+pad});
    const hits=[];let nearest=Infinity;
    for(const cam of cams){const lat=+cam.lat,lng=+cam.lng,limit=exclusionMeters(cam);let best=Infinity,bestSeg=-1;
      for(let i=0;i<coords.length-1;i++){const a=coords[i],b=coords[i+1];const segMinLat=Math.min(a[1],b[1])-.001,segMaxLat=Math.max(a[1],b[1])+.001,segMinLng=Math.min(a[0],b[0])-.001,segMaxLng=Math.max(a[0],b[0])+.001;if(lat<segMinLat||lat>segMaxLat||lng<segMinLng||lng>segMaxLng)continue;const d=pointToSegmentMeters(lat,lng,+a[1],+a[0],+b[1],+b[0]);if(d<best){best=d;bestSeg=i}if(best<=limit)break}
      if(best<nearest)nearest=best;if(best<=limit)hits.push({camera:cam,distance:best,exclusion:limit,segmentIndex:bestSeg});}
    hits.sort((a,b)=>a.distance-b.distance);return{clear:hits.length===0,hits,nearest};
  }

  function targetedWaypointSets(item,hit){
    const cam=hit.camera,coords=item.route.geometry.coordinates,idx=Math.max(0,Math.min(hit.segmentIndex,coords.length-2));
    const a=[coords[idx][1],coords[idx][0]],b=[coords[idx+1][1],coords[idx+1][0]],travel=bearing(a,b),left=(travel+270)%360,right=(travel+90)%360;
    const sets=[];
    for(const r of TARGET_RADII){
      sets.push([destinationPoint(+cam.lat,+cam.lng,left,r)]);
      sets.push([destinationPoint(+cam.lat,+cam.lng,right,r)]);
      if(r>=700){
        sets.push([destinationPoint(+cam.lat,+cam.lng,left,r),destinationPoint(+cam.lat,+cam.lng,(left+25)%360,r*1.15)]);
        sets.push([destinationPoint(+cam.lat,+cam.lng,right,r),destinationPoint(+cam.lat,+cam.lng,(right+335)%360,r*1.15)]);
      }
    }
    return sets;
  }

  async function surgicalBypass(start,dest,seed,tested){
    let current=seed,checked=0;
    const solvedKeys=new Set();
    for(let round=1;round<=12;round++){
      if(current.audit.clear)return{best:current,checked};
      const hit=current.audit.hits.find(h=>!solvedKeys.has(cameraKey(h.camera)))||current.audit.hits[0];
      if(!hit)break;
      progress(`Bypassing camera ${round} • ${current.audit.hits.length} conflict${current.audit.hits.length===1?'':'s'} remaining…`);
      const sets=targetedWaypointSets(current,hit);
      const batch=await mapLimit(sets,2,async via=>{const routes=await requestRoutes([start,...via,dest],false);checked++;if(!routes.length)return null;const item={route:routes[0],audit:auditRoute(routes[0]),via};tested.push(item);return item});
      const clear=bestClear(batch);if(clear)return{best:clear,checked};
      const improved=leastBlocked(batch);
      if(improved && (improved.audit.hits.length<current.audit.hits.length || improved.audit.nearest>current.audit.nearest+5)){
        current=improved;solvedKeys.add(cameraKey(hit.camera));continue;
      }
      solvedKeys.add(cameraKey(hit.camera));
      const fallback=leastBlocked([...tested,current]);if(fallback)current=fallback;
    }
    return{best:null,checked,closest:current};
  }

  async function regionalFallback(start,dest,tested){
    let checked=0;const center=midpoint(start,dest),sets=[];
    for(const r of REGIONAL_RADII)for(const b of DETOUR_BEARINGS){sets.push([destinationPoint(center[0],center[1],b,r)]);if(r<=260000)sets.push([destinationPoint(center[0],center[1],b,r),destinationPoint(center[0],center[1],(b+35)%360,r*1.05)])}
    progress('Expanding Shadow Route around the entire surveillance field…');
    const results=await mapLimit(sets,2,async via=>{const routes=await requestRoutes([start,...via,dest],false);checked++;if(!routes.length)return null;const item={route:routes[0],audit:auditRoute(routes[0]),via};tested.push(item);return item});
    return{best:bestClear(results),checked,closest:leastBlocked(results)};
  }

  async function findClearRoute(start,dest){
    const tested=[];let checked=0;
    progress('Checking direct Shadow Route alternatives…');
    const base=await requestRoutes([start,dest],true);
    for(const r of base){checked++;const item={route:r,audit:auditRoute(r),via:[]};tested.push(item);if(item.audit.clear)return{best:item,checked,tested}}
    if(!tested.length)return{best:null,checked,tested};
    let seed=leastBlocked(tested);
    const surgery=await surgicalBypass(start,dest,seed,tested);checked+=surgery.checked;if(surgery.best)return{best:surgery.best,checked,tested};
    seed=surgery.closest||leastBlocked(tested);
    if(seed?.audit?.hits?.length){const retry=await surgicalBypass(start,dest,seed,tested);checked+=retry.checked;if(retry.best)return{best:retry.best,checked,tested};}
    const regional=await regionalFallback(start,dest,tested);checked+=regional.checked;if(regional.best)return{best:regional.best,checked,tested};
    const lastSeed=regional.closest||leastBlocked(tested);if(lastSeed?.audit?.hits?.length){const last=await surgicalBypass(start,dest,lastSeed,tested);checked+=last.checked;if(last.best)return{best:last.best,checked,tested};}
    return{best:null,checked,tested,closest:leastBlocked(tested)};
  }

  async function strictCameraFreeSearch(){
    const query=document.getElementById('dest-address')?.value?.trim();if(!query)return;
    closeSearch();clearExistingRoute();
    const blocking=(cameraLocations||[]).filter(isRouteBlocking);
    if(!blocking.length){if(typeof showHudModal==='function')showHudModal('Camera Mesh Not Ready','GhostLane will not calculate a Shadow Route until surveillance intelligence is loaded. Wait a moment and try again.',{tone:'danger'});return}
    progress(`Shadow Route • ${blocking.length} surveillance nodes loaded`);
    try{
      const nom=await fetchJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`,9000);
      if(!nom.length)throw new Error('Destination not found.');
      if(!Array.isArray(userCoords)||!Number.isFinite(+userCoords[0])||!Number.isFinite(+userCoords[1]))throw new Error('Current GPS location is not ready yet.');
      const dest=[+nom[0].lat,+nom[0].lon],start=[+userCoords[0],+userCoords[1]],result=await findClearRoute(start,dest);
      if(!result.best){clearExistingRoute();const near=result.closest?.audit?.hits?.length||0;if(typeof showHudModal==='function')showHudModal('No Verified Zero-Camera Route',`GhostLane performed targeted camera-by-camera bypassing plus regional detours up to 500 miles, but could not verify a route outside every mapped surveillance zone.${near?` Best remaining candidate crosses ${near} mapped surveillance zone${near===1?'':'s'}.`:''}`,{tone:'danger'});return}
      const r=result.best.route,latlngs=r.geometry.coordinates.map(p=>[p[1],p[0]]);routePolyline=L.polyline(latlngs,{color:'#38bdf8',weight:6,dashArray:'8, 8'}).addTo(map);map.fitBounds(routePolyline.getBounds(),{padding:[60,60]});routeSteps=(r.legs||[]).flatMap(l=>l.steps||[]);currentStepIdx=0;if(routeSteps.length){const hud=document.getElementById('turn-hud');if(hud)hud.style.display='flex';updateTurnHUD(routeSteps[0])}const miles=((r.distance||0)/1609.344).toFixed(1),minutes=Math.round((r.duration||0)/60);progress(`ZERO-CAMERA ROUTE VERIFIED • ${miles} mi • ~${minutes} min • ${result.checked} checked`)
    }catch(err){clearExistingRoute();const msg=err?.name==='AbortError'?'Routing service timed out. Please try again.':(err.message||'GhostLane could not calculate a surveillance-free route.');if(typeof showHudModal==='function')showHudModal('Route Unavailable',msg,{tone:'danger'})}
  }
  window.executeSearch=strictCameraFreeSearch;
})();