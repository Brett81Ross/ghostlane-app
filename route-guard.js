(()=>{
  const VERSION='1.4.1';
  const CRITICAL_METERS=60;
  const AVOID_METERS=140;
  const SAMPLE_STRIDE=3;

  function cameraWeight(cam){
    const text=`${cam.label||''} ${cam.type||''} ${cam.source||''}`.toLowerCase();
    if(/flock|alpr|license plate|plate reader/.test(text)) return 1.45;
    if(cam.confidence==='verified'||cam._cloud||cam._manual) return 1.25;
    if(cam.confidence==='unconfirmed') return .75;
    return 1;
  }

  function routeRisk(route){
    const coords=(route.geometry&&route.geometry.coordinates)||[];
    let penalty=0, criticalHits=0, avoidHits=0, nearest=Infinity;
    const hitKeys=new Set();
    for(let i=0;i<coords.length;i+=SAMPLE_STRIDE){
      const pt=[coords[i][1],coords[i][0]];
      for(const cam of cameraLocations||[]){
        const d=map.distance(pt,[+cam.lat,+cam.lng]);
        if(d<nearest) nearest=d;
        if(d>AVOID_METERS) continue;
        const key=String(cam.node_id||cam.id||`${cam.lat},${cam.lng}`);
        const w=cameraWeight(cam);
        if(d<=CRITICAL_METERS){
          penalty += (CRITICAL_METERS-d+80)*14*w;
          if(!hitKeys.has(`c:${key}`)){criticalHits++;hitKeys.add(`c:${key}`)}
        }else{
          penalty += (AVOID_METERS-d+20)*3*w;
          if(!hitKeys.has(`a:${key}`)){avoidHits++;hitKeys.add(`a:${key}`)}
        }
      }
    }
    penalty += (route.distance||0)*0.02;
    return {penalty,criticalHits,avoidHits,nearest};
  }

  function instructionFor(step){
    if(!step) return 'Proceed along Shadow Vector';
    return step.maneuver?.instruction || (step.name?`Proceed onto ${step.name}`:'Proceed along Shadow Vector');
  }

  async function cameraAwareSearch(){
    const query=document.getElementById('dest-address')?.value?.trim();
    if(!query)return;
    closeSearch();
    if(typeof showHudToast==='function')showHudToast('Scanning route alternatives against surveillance mesh…');
    if(typeof speakAlert==='function')speakAlert('Calculating surveillance aware route.');
    try{
      const nomUrl=`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
      const res=await fetch(nomUrl,{headers:{'Accept':'application/json'}}),data=await res.json();
      if(!data.length)throw new Error('Destination not found.');
      const dest=[+data[0].lat,+data[0].lon];
      const start=`${userCoords[1]},${userCoords[0]}`,end=`${dest[1]},${dest[0]}`;
      const osrm=`https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=full&geometries=geojson&steps=true&alternatives=3`;
      const rr=await fetch(osrm),rd=await rr.json();
      const routes=rd.routes||[];
      if(!routes.length)throw new Error('No drivable route found.');

      const ranked=routes.map((r,i)=>({route:r,risk:routeRisk(r),index:i})).sort((a,b)=>a.risk.penalty-b.risk.penalty);
      const best=ranked[0];
      const r=best.route;
      if(routePolyline)map.removeLayer(routePolyline);
      const latlngs=r.geometry.coordinates.map(p=>[p[1],p[0]]);
      routePolyline=L.polyline(latlngs,{color:'#38bdf8',weight:6,dashArray:'8, 8'}).addTo(map);
      map.fitBounds(routePolyline.getBounds(),{padding:[60,60]});
      routeSteps=r.legs?.[0]?.steps||[];
      currentStepIdx=0;
      if(routeSteps.length){
        document.getElementById('turn-hud').style.display='flex';
        updateTurnHUD(routeSteps[0]);
      }

      const feet=Number.isFinite(best.risk.nearest)?Math.round(best.risk.nearest*3.28084):null;
      if(best.risk.criticalHits>0){
        const msg=`No camera-clear route was found. Best available route passes near ${best.risk.criticalHits} high-risk surveillance node${best.risk.criticalHits===1?'':'s'}${feet?`, nearest about ${feet} ft`:''}.`;
        if(typeof showHudModal==='function')showHudModal('Surveillance Exposure Warning',msg,{tone:'danger'});
        if(typeof speakAlert==='function')speakAlert('Warning. No camera clear route found. Surveillance exposure remains on the best available route.');
      }else if(best.risk.avoidHits>0){
        const msg=`Shadow Route selected the lowest-surveillance option from ${routes.length} route alternative${routes.length===1?'':'s'}. ${best.risk.avoidHits} mapped camera${best.risk.avoidHits===1?' is':'s are'} still within the caution buffer.`;
        if(typeof showHudToast==='function')showHudToast(msg,'orange');
      }else{
        const msg=`Camera-aware route selected from ${routes.length} alternative${routes.length===1?'':'s'} • no mapped cameras inside the ${AVOID_METERS} m avoidance buffer.`;
        if(typeof showHudToast==='function')showHudToast(msg);
        if(typeof speakAlert==='function')speakAlert('Lowest surveillance route selected.');
      }

      const first=routeSteps[0];
      if(first&&typeof speakAlert==='function')setTimeout(()=>speakAlert(instructionFor(first)),900);
      console.info('[GhostLane] Camera-aware route', {version:VERSION,alternatives:routes.length,risk:best.risk});
    }catch(err){
      console.error('[GhostLane] camera-aware route failed',err);
      if(typeof showHudModal==='function')showHudModal('Route Unavailable',err.message||'GhostLane could not calculate a route.',{tone:'danger'});
    }
  }

  window.executeSearch=cameraAwareSearch;
  console.info(`[GhostLane] camera-aware Shadow Route ${VERSION} active`);
})();