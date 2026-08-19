(()=>{
  const KEY='gl_observer_reports_v121';
  const TTL=24*60*60*1000;
  const layer=L.layerGroup().addTo(map);
  let refreshTimer=null;

  function reports(){
    try{
      const all=JSON.parse(localStorage.getItem(KEY)||'[]');
      return all.filter(r=>r&&Number.isFinite(+r.lat)&&Number.isFinite(+r.lng)&&(r.test||Date.now()-(+r.time||0)<TTL));
    }catch(_){return[]}
  }
  function ageText(t){
    const ms=Math.max(0,Date.now()-(+t||Date.now()));
    const m=Math.floor(ms/60000);
    if(m<1)return 'JUST NOW';
    if(m<60)return `${m} MIN AGO`;
    const h=Math.floor(m/60);
    return h<24?`${h} HR${h===1?'':'S'} AGO`:`${Math.floor(h/24)}D AGO`;
  }
  function confidenceLabel(v){
    if(v==='verified')return 'VERIFIED';
    if(v==='unconfirmed')return 'UNCONFIRMED';
    return 'COMMUNITY';
  }
  function markerColor(v){
    if(v==='verified')return '#4ade80';
    if(v==='unconfirmed')return '#f97316';
    return '#38bdf8';
  }
  function opacityFor(t,test){
    if(test)return .92;
    const age=Math.max(0,Date.now()-(+t||Date.now()));
    return Math.max(.28,1-(age/TTL)*.72);
  }
  function safe(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function iconFor(r){
    const color=markerColor(r.confidence),op=opacityFor(r.time,r.test);
    return L.divIcon({className:'ghostlane-live-intel-icon',iconSize:[38,38],iconAnchor:[19,19],popupAnchor:[0,-17],html:`<div style="width:38px;height:38px;display:flex;align-items:center;justify-content:center;opacity:${op};filter:drop-shadow(0 0 8px ${color});"><div style="width:25px;height:25px;border:2px solid ${color};background:rgba(5,7,13,.92);transform:rotate(45deg);display:flex;align-items:center;justify-content:center;"><span style="transform:rotate(-45deg);font-size:11px;font-weight:900;color:${color};">${r.test?'T':'●'}</span></div></div>`});
  }
  function popup(r){
    const color=markerColor(r.confidence);
    return `<div style="min-width:190px"><div style="font-size:.65rem;font-weight:900;letter-spacing:1px;color:${color};margin-bottom:5px">LIVE INTEL • ${confidenceLabel(r.confidence)}${r.test?' • TEST':''}</div><div style="font-size:.84rem;font-weight:900;color:#f8fafc">${safe(r.type||'Observation')}</div><div style="margin-top:6px;color:#94a3b8;font-size:.7rem">${ageText(r.time)} • GPS ±${Math.round(+r.accuracy||0)}m</div>${r.note?`<div style="margin-top:7px;color:#cbd5e1;font-size:.72rem;line-height:1.4">${safe(r.note)}</div>`:''}<div style="margin-top:8px;color:#64748b;font-size:.62rem">Temporary observation • expires after 24 hours</div></div>`;
  }
  function updateChip(count){
    let chip=document.getElementById('gl-live-intel-chip');
    if(!chip){
      chip=document.createElement('button');
      chip.id='gl-live-intel-chip';
      chip.type='button';
      chip.onclick=()=>location.href='/observer.html';
      chip.style.cssText='position:absolute;left:12px;top:12px;z-index:1200;border:1px solid rgba(74,222,128,.55);background:rgba(5,7,13,.9);color:#4ade80;border-radius:999px;padding:8px 11px;font-size:.62rem;font-weight:900;letter-spacing:.7px;box-shadow:0 4px 14px rgba(0,0,0,.5);backdrop-filter:blur(6px);';
      const wrapper=document.getElementById('map-wrapper');
      if(wrapper)wrapper.appendChild(chip);
    }
    chip.textContent=`LIVE INTEL ${count}`;
  }
  function render(){
    layer.clearLayers();
    const list=reports();
    list.forEach(r=>L.marker([+r.lat,+r.lng],{icon:iconFor(r),zIndexOffset:800}).bindPopup(popup(r),{maxWidth:260}).addTo(layer));
    updateChip(list.length);
  }
  render();
  refreshTimer=setInterval(render,15000);
  window.addEventListener('storage',e=>{if(e.key===KEY)render()});
  window.addEventListener('focus',render);
  console.info('[GhostLane] Live Intel layer active:',reports().length,'reports');
})();