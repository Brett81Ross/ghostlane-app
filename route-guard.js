(()=>{
  const VERSION='1.6.7';
  const REQUEST_TIMEOUT_MS=9000;
  const MAX_SINGLE_WAYPOINT_CANDIDATES=40;
  const MAX_DETOUR_METERS=804672;
  const LOCAL_RADII_METERS=[500,1000,2000,4000,8000,14000,22000,35000,55000];
  const REGIONAL_RADII_METERS=[80000,120000,180000,260000,400000,600000,804672];
  const DETOUR_BEARINGS=[0,45,90,135,180,225,270,315];

  function cameraKey(cam){return String(cam.node_id||cam.id||`${cam.lat},${cam.lng}`)}
  function isRouteBlocking(cam){if(cam.routeBlocking===false)return false;return !['red-light','speed','traffic'].includes(cam.category)}
  function exclusionMeters(cam){const text=`${cam.label||''} ${cam.type||''} ${cam.source||''}`.toLowerCase();if(/falcon\s*lr|long[- ]?range|\blr\b/.test(text))return 50;if(/falcon\s*sr|short[- ]?range|\bsr\b/.test(text))return 22;if(/flock|alpr|lpr|license plate|plate reader/.test(text))return 35;return 30}
  function clearExistingRoute(){if(routePolyline){try{map.removeLayer(routePolyline)}catch(_){}routePolyline=null}routeSteps=[];currentStepIdx=0;const hud=document.getElementById('turn-hud');if(hud)hud.style.display='none'}
  function destinationPoint(lat,lng,bearingDeg,distanceM){const R=6371000,br=bearingDeg*Math.PI/180,p1=lat*Math.PI/180,l1=lng*Math.PI/180,d=distanceM/R,p2=Math.asin(Math.sin(p1)*Math.cos(d)+Math.cos(p1)*Math.sin(d)*Math.cos(br)),l2=l1+Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(p1),Math.cos(d)-Math.sin(p1)*Math.sin(p2));return[p2*180/Math.PI,((l2*180/Math.PI+540)%360)-180]}
  function midpoint(a,b){return[(a[0]+b[0])/2,(a[1]+b[1])/2]}
  async function fetchJson(url,ms=REQUEST_TIMEOUT_MS){const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{signal:c.signal,headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json()}finally{clearTimeout(t)}}
  async function requestRoutes(points,alternatives=true){const coords=points.map(p=>`${p[1]},${p[0]}`).join(';'),url=`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&alternatives=${alternatives?'true':'false'}`;const data=await fetchJson(url);return data.routes||[]}
  async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(next<items.length){const i=next++;try{out[i]=await fn(items[i],i)}catch(e){out[i]=null}await new Promise(r=>setTimeout(r,0))}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out}
  function progress(text){if(typeof showHudToast==='function')showHudToast(text)}
  function bestClear(items){return items.filter(Boolean).filter(x=>x.audit?.clear).sort((a,b)=>(a.route.distance||Infinity)-(b.route.distance||Infinity))[0]||null}
  function leastBlocked(items){return items.filter(Boolean).filter(x=>x.route).sort((a,b)=>a.audit.hits.length-b.audit.hits.length||b.audit.nearest-a.audit.nearest||(a.route.distance||Infinity)-(b.route.distance||Infinity))[0]||null}

  function pointToSegmentMeters(pLat,pLng,aLat,aLng,bLat,bLng){
    const lat0=pLat*Math.PI/180;
    const mx=111320*Math.cos(lat0),my=110540;
    const px=0,py=0;
    const ax=(aLng-pLng)*mx,ay=(aLat-pLat)*my;
    const bx=(bLng-pLng)*mx,by=(bLat-pLat)*my;
    const vx=bx-ax,vy=by-ay;
    const len2=vx*vx+vy*vy;
    let t=len2>0?((px-ax)*vx+(py-ay)*vy)/len2:0;
    t=Math.max(0,Math.min(1,t));
    const x=ax+t*vx,y=ay+t*vy;
    return Math.hypot(x,y);
  }

  function auditRoute(route){
    const coords=route?.geometry?.coordinates||[];
    if(coords.length<2)return{clear:false,hits:[],nearest:0,segmentsChecked:0};
    let minLat=Infinity,maxLat=-Infinity,minLng=Infinity,maxLng=-Infinity;
    for(const c of coords){const lng=+c[0],lat=+c[1];if(lat<minLat)minLat=lat;if(lat>maxLat)maxLat=lat;if(lng<minLng)minLng=lng;if(lng>maxLng)maxLng=lng}
    const pad=.0012;
    const cams=(cameraLocations||[]).filter(cam=>{
      if(!isRouteBlocking(cam))return false;
      const lat=+cam.lat,lng=+cam.lng;
      return Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=minLat-pad&&lat<=maxLat+pad&&lng>=minLng-pad&&lng<=maxLng+pad;
    });
    const hits=[];let nearest=Infinity,segmentsChecked=0;
    for(const cam of cams){
      const lat=+cam.lat,lng=+cam.lng,limit=exclusionMeters(cam);
      let best=Infinity;
      for(let i=0;i<coords.length-1;i++){
        const a=coords[i],b=coords[i+1];
        const segMinLat=Math.min(a[1],b[1])-.001,segMaxLat=Math.max(a[1],b[1])+.001,segMinLng=Math.min(a[0],b[0])-.001,segMaxLng=Math.max(a[0],b[0])+.001;
        if(lat<segMinLat||lat>segMaxLat||lng<segMinLng||lng>segMaxLng)continue;
        segmentsChecked++;
        const d=pointToSegmentMeters(lat,lng,+a[1],+a[0],+b[1],+b[0]);
        if(d<best)best=d;
        if(best<=limit)break;
      }
      if(best<nearest)nearest=best;
      if(best<=limit)hits.push({camera:cam,distance:best,exclusion:limit});
    }
    hits.sort((a,b)=>a.distance-b.distance);
    return{clear:hits.length===0,hits,nearest,segmentsChecked};
  }

  async function testWaypointSets(start,dest,sets,tested,label){
    progress(label);
    let checked=0;
    const results=await mapLimit(sets,3,async(via,index)=>{
      const routes=await requestRoutes([start,...via,dest],false);
      checked++;
      if((index+1)%3===0)progress(`${label} • ${Math.min(index+1,sets.length)}/${sets.length}`);
      if(!routes.length)return null;
      await new Promise(r=>setTimeout(r,0));
      const item={route:routes[0],audit:auditRoute(routes[0]),via};tested.push(item);return item;
    });
    return{clear:bestClear(results),checked};
  }

  async function findClearRoute(start,dest){
    const tested=[];let checked=0;
    progress('Checking direct Shadow Route alternatives…');
    const base=await requestRoutes([start,dest],true);
    for(const r of base){checked++;await new Promise(res=>setTimeout(res,0));const item={route:r,audit:auditRoute(r),via:[]};tested.push(item);if(item.audit.clear)return{best:item,checked,tested}}
    if(!tested.length)return{best:null,checked,tested};

    const blockers=[];const seen=new Set();
    for(const item of [...tested].sort((a,b)=>a.audit.hits.length-b.audit.hits.length)){for(const hit of item.audit.hits){const k=cameraKey(hit.camera);if(!seen.has(k)){seen.add(k);blockers.push(hit.camera)}if(blockers.length>=6)break}if(blockers.length>=6)break}

    const single=[];
    for(const cam of blockers){for(const radius of LOCAL_RADII_METERS){for(const bearing of DETOUR_BEARINGS){single.push([destinationPoint(+cam.lat,+cam.lng,bearing,radius)]);if(single.length>=MAX_SINGLE_WAYPOINT_CANDIDATES)break}if(single.length>=MAX_SINGLE_WAYPOINT_CANDIDATES)break}if(single.length>=MAX_SINGLE_WAYPOINT_CANDIDATES)break}
    const local=await testWaypointSets(start,dest,single,tested,'Searching local camera bypasses…');checked+=local.checked;if(local.clear)return{best:local.clear,checked,tested};

    const cluster=leastBlocked(tested);
    if(cluster?.audit?.hits?.length){
      const cams=cluster.audit.hits.map(h=>h.camera),avgLat=cams.reduce((s,c)=>s+(+c.lat),0)/cams.length,avgLng=cams.reduce((s,c)=>s+(+c.lng),0)/cams.length;
      const twoPoint=[];
      for(const radius of [12000,22000,35000,55000,80000])for(const bearing of DETOUR_BEARINGS){const a=destinationPoint(avgLat,avgLng,bearing-22.5,radius),b=destinationPoint(avgLat,avgLng,bearing+22.5,radius);twoPoint.push([a,b])}
      const around=await testWaypointSets(start,dest,twoPoint,tested,'Routing around the surveillance cluster…');checked+=around.checked;if(around.clear)return{best:around.clear,checked,tested};
    }

    const center=midpoint(start,dest),regional=[];
    for(const radius of REGIONAL_RADII_METERS)for(const bearing of DETOUR_BEARINGS){const flank=destinationPoint(center[0],center[1],bearing,radius);regional.push([flank]);const flank2=destinationPoint(center[0],center[1],bearing+30,radius);regional.push([flank,flank2])}
    const wide=await testWaypointSets(start,dest,regional,tested,'Expanding Shadow Route — up to 500-mile detours…');checked+=wide.checked;if(wide.clear)return{best:wide.clear,checked,tested};

    const extreme=[];
    for(const bearing of [0,90,180,270]){const p1=destinationPoint(center[0],center[1],bearing,MAX_DETOUR_METERS),p2=destinationPoint(center[0],center[1],bearing+45,MAX_DETOUR_METERS),p3=destinationPoint(center[0],center[1],bearing+90,MAX_DETOUR_METERS);extreme.push([p1,p2],[p1,p2,p3])}
    const last=await testWaypointSets(start,dest,extreme,tested,'Maximum-detour sweep…');checked+=last.checked;if(last.clear)return{best:last.clear,checked,tested};
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
      if(!result.best){clearExistingRoute();const near=result.closest?.audit?.hits?.length||0;if(typeof showHudModal==='function')showHudModal('No Verified Zero-Camera Route',`GhostLane searched ${result.checked} direct, local, regional, and maximum-detour routes — including detours up to 500 miles — but could not verify a camera-free route with the currently mapped surveillance network.${near?` Closest candidate still crossed ${near} mapped surveillance zone${near===1?'':'s'}.`:''}`,{tone:'danger'});return}
      const r=result.best.route,latlngs=r.geometry.coordinates.map(p=>[p[1],p[0]]);routePolyline=L.polyline(latlngs,{color:'#38bdf8',weight:6,dashArray:'8, 8'}).addTo(map);map.fitBounds(routePolyline.getBounds(),{padding:[60,60]});routeSteps=(r.legs||[]).flatMap(l=>l.steps||[]);currentStepIdx=0;if(routeSteps.length){const hud=document.getElementById('turn-hud');if(hud)hud.style.display='flex';updateTurnHUD(routeSteps[0])}const miles=((r.distance||0)/1609.344).toFixed(1),minutes=Math.round((r.duration||0)/60);progress(`ZERO-CAMERA ROUTE VERIFIED • ${miles} mi • ~${minutes} min • ${result.checked} checked`)
    }catch(err){clearExistingRoute();const msg=err?.name==='AbortError'?'Routing service timed out. Please try again.':(err.message||'GhostLane could not calculate a surveillance-free route.');if(typeof showHudModal==='function')showHudModal('Route Unavailable',msg,{tone:'danger'})}
  }
  window.executeSearch=strictCameraFreeSearch;
})();