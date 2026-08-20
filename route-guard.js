(()=>{
  const VERSION='1.4.2';
  const HARD_AVOID_METERS=150;
  const MAX_SAMPLE_GAP_METERS=20;

  function cameraKey(cam){
    return String(cam.node_id||cam.id||`${cam.lat},${cam.lng}`);
  }

  function denseRoutePoints(route){
    const coords=(route.geometry&&route.geometry.coordinates)||[];
    if(!coords.length)return [];
    const out=[];
    for(let i=0;i<coords.length-1;i++){
      const a=[coords[i][1],coords[i][0]];
      const b=[coords[i+1][1],coords[i+1][0]];
      const meters=map.distance(a,b);
      const steps=Math.max(1,Math.ceil(meters/MAX_SAMPLE_GAP_METERS));
      for(let s=0;s<steps;s++){
        const t=s/steps;
        out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);
      }
    }
    const last=coords[coords.length-1];
    out.push([last[1],last[0]]);
    return out;
  }

  function auditRoute(route){
    const points=denseRoutePoints(route);
    const hitMap=new Map();
    let nearest=Infinity;
    for(const pt of points){
      for(const cam of cameraLocations||[]){
        const lat=+cam.lat,lng=+cam.lng;
        if(!Number.isFinite(lat)||!Number.isFinite(lng))continue;
        const d=map.distance(pt,[lat,lng]);
        if(d<nearest)nearest=d;
        if(d<=HARD_AVOID_METERS){
          const key=cameraKey(cam);
          const prior=hitMap.get(key);
          if(!prior||d<prior.distance)hitMap.set(key,{camera:cam,distance:d});
        }
      }
    }
    const hits=[...hitMap.values()].sort((a,b)=>a.distance-b.distance);
    return {clear:hits.length===0,hits,nearest,pointsChecked:points.length};
  }

  function instructionFor(step){
    if(!step)return 'Proceed along Shadow Vector';
    return step.maneuver?.instruction||(step.name?`Proceed onto ${step.name}`:'Proceed along Shadow Vector');
  }

  function clearExistingRoute(){
    if(routePolyline){try{map.removeLayer(routePolyline)}catch(_){} routePolyline=null;}
    routeSteps=[];
    currentStepIdx=0;
    const hud=document.getElementById('turn-hud');
    if(hud)hud.style.display='none';
  }

  async function strictCameraFreeSearch(){
    const query=document.getElementById('dest-address')?.value?.trim();
    if(!query)return;
    closeSearch();
    clearExistingRoute();

    if(!Array.isArray(cameraLocations)||cameraLocations.length===0){
      if(typeof showHudModal==='function')showHudModal('Camera Mesh Not Ready','GhostLane will not calculate a Shadow Route until camera intelligence is loaded. Wait a moment and try again.',{tone:'danger'});
      return;
    }

    if(typeof showHudToast==='function')showHudToast(`Zero-camera scan • checking ${cameraLocations.length} mapped surveillance nodes…`);
    if(typeof speakAlert==='function')speakAlert('Calculating strict camera free route.');

    try{
      const nomUrl=`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
      const res=await fetch(nomUrl,{headers:{Accept:'application/json'}});
      const data=await res.json();
      if(!data.length)throw new Error('Destination not found.');

      const dest=[+data[0].lat,+data[0].lon];
      const start=`${userCoords[1]},${userCoords[0]}`;
      const end=`${dest[1]},${dest[0]}`;
      const osrm=`https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=full&geometries=geojson&steps=true&alternatives=true`;
      const rr=await fetch(osrm);
      const rd=await rr.json();
      const routes=rd.routes||[];
      if(!routes.length)throw new Error('No drivable route found.');

      const audited=routes.map((route,index)=>({route,index,audit:auditRoute(route)}));
      const clearRoutes=audited.filter(x=>x.audit.clear).sort((a,b)=>(a.route.distance||Infinity)-(b.route.distance||Infinity));

      if(!clearRoutes.length){
        clearExistingRoute();
        const closest=audited.sort((a,b)=>a.audit.hits.length-b.audit.hits.length||b.audit.nearest-a.audit.nearest)[0];
        const nearest=closest&&Number.isFinite(closest.audit.nearest)?Math.round(closest.audit.nearest*3.28084):null;
        const count=closest?.audit?.hits?.length||0;
        const detail=count?`The least-exposed candidate still enters the ${HARD_AVOID_METERS} m exclusion zone of ${count} mapped camera${count===1?'':'s'}${nearest?`; nearest approximately ${nearest} ft`:''}.`:'';
        if(typeof showHudModal==='function')showHudModal('No Zero-Camera Route','GhostLane refused to start navigation because every available route intersects mapped surveillance. '+detail+' No route is safer than knowingly routing through a camera.',{tone:'danger'});
        if(typeof speakAlert==='function')speakAlert('No camera free route found. Navigation blocked.');
        console.warn('[GhostLane] strict route blocked',{version:VERSION,candidates:routes.length,audited});
        return;
      }

      const best=clearRoutes[0];
      const r=best.route;
      const latlngs=r.geometry.coordinates.map(p=>[p[1],p[0]]);
      routePolyline=L.polyline(latlngs,{color:'#38bdf8',weight:6,dashArray:'8, 8'}).addTo(map);
      map.fitBounds(routePolyline.getBounds(),{padding:[60,60]});
      routeSteps=r.legs?.[0]?.steps||[];
      currentStepIdx=0;
      if(routeSteps.length){
        const hud=document.getElementById('turn-hud');
        if(hud)hud.style.display='flex';
        updateTurnHUD(routeSteps[0]);
      }

      const nearestFeet=Number.isFinite(best.audit.nearest)?Math.round(best.audit.nearest*3.28084):null;
      const msg=`ZERO-CAMERA ROUTE • ${clearRoutes.length}/${routes.length} candidate route${routes.length===1?'':'s'} clear • no mapped camera within ${HARD_AVOID_METERS} m${nearestFeet?` • nearest mapped camera ~${nearestFeet} ft`:''}.`;
      if(typeof showHudToast==='function')showHudToast(msg);
      if(typeof speakAlert==='function')speakAlert('Zero camera route verified against the current mapped camera database.');
      const first=routeSteps[0];
      if(first&&typeof speakAlert==='function')setTimeout(()=>speakAlert(instructionFor(first)),900);
      console.info('[GhostLane] strict zero-camera route accepted',{version:VERSION,candidates:routes.length,clearCandidates:clearRoutes.length,audit:best.audit});
    }catch(err){
      clearExistingRoute();
      console.error('[GhostLane] strict route failed',err);
      if(typeof showHudModal==='function')showHudModal('Route Unavailable',err.message||'GhostLane could not calculate a camera-free route.',{tone:'danger'});
    }
  }

  window.executeSearch=strictCameraFreeSearch;
  console.info(`[GhostLane] strict zero-camera Shadow Route ${VERSION} active • hard exclusion ${HARD_AVOID_METERS}m`);
})();