(()=>{
  const APP_URL='https://ghostlane-app.vercel.app/radar.html';
  const QR_URL='/ghostlane-qr.svg?v=1.3.1';
  const header=document.querySelector('header');
  if(!header||document.getElementById('gl-share-btn'))return;
  header.style.position='relative';
  const btn=document.createElement('button');
  btn.id='gl-share-btn'; btn.type='button'; btn.setAttribute('aria-label','Share GhostLane'); btn.title='Share GhostLane';
  btn.innerHTML='<span style="font-size:17px;line-height:1">↗</span><span>SHARE</span>';
  btn.style.cssText='margin-left:auto;display:flex;align-items:center;gap:6px;border:1px solid rgba(56,189,248,.48);background:rgba(15,23,42,.9);color:#38bdf8;border-radius:999px;padding:9px 12px;font-size:.62rem;font-weight:900;letter-spacing:.7px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);';
  header.appendChild(btn);

  const modal=document.createElement('div');
  modal.id='gl-share-modal';
  modal.style.cssText='display:none;position:fixed;inset:0;z-index:5000;background:rgba(2,6,14,.86);backdrop-filter:blur(8px);padding:18px;align-items:center;justify-content:center;';
  modal.innerHTML=`<div style="width:min(94vw,420px);max-height:92vh;overflow:auto;background:linear-gradient(180deg,#0b1120,#06080e);border:1px solid rgba(56,189,248,.52);border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.8);padding:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px"><div><div style="font-size:.9rem;font-weight:900;color:#fff">Share GhostLane™</div><div style="font-size:.67rem;color:#64748b;margin-top:3px">Scan, share, or save the app QR</div></div><button id="gl-share-close" style="width:38px;height:38px;border-radius:50%;border:1px solid #1e293b;background:#111827;color:#94a3b8;font-size:20px">×</button></div>
    <img src="${QR_URL}" alt="GhostLane QR code" style="display:block;width:100%;border-radius:14px;background:#06080e;border:1px solid rgba(56,189,248,.2)"/>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px"><button id="gl-share-app" style="border:0;border-radius:10px;padding:12px;background:#38bdf8;color:#020617;font-size:.7rem;font-weight:900">SHARE APP</button><button id="gl-share-qr" style="border:0;border-radius:10px;padding:12px;background:#4ade80;color:#052e16;font-size:.7rem;font-weight:900">SHARE QR</button></div>
    <button id="gl-download-qr" style="width:100%;margin-top:9px;border:1px solid #334155;border-radius:10px;padding:11px;background:#111827;color:#e2e8f0;font-size:.68rem;font-weight:900">DOWNLOAD QR CODE</button>
    <div style="margin-top:10px;text-align:center;color:#475569;font-size:.58rem;font-weight:700">GhostLane™ • v1.3.1 • Cactus🌵Byte Studios™ • All Rights Reserved</div>
  </div>`;
  document.body.appendChild(modal);
  const open=()=>{modal.style.display='flex'}; const close=()=>{modal.style.display='none'};
  btn.onclick=open; document.getElementById('gl-share-close').onclick=close; modal.addEventListener('click',e=>{if(e.target===modal)close()});
  async function shareApp(){
    const data={title:'GhostLane™',text:'GhostLane™ — privacy intelligence for the road ahead.',url:APP_URL};
    try{if(navigator.share){await navigator.share(data)}else{await navigator.clipboard.writeText(APP_URL); if(typeof showHudToast==='function')showHudToast('GhostLane link copied.')}}catch(e){if(e?.name!=='AbortError'&&typeof showHudToast==='function')showHudToast('Share canceled or unavailable.','orange')}
  }
  async function qrFile(){const r=await fetch(QR_URL);const blob=await r.blob();return new File([blob],'GhostLane-QR.svg',{type:'image/svg+xml'})}
  async function shareQr(){
    try{const file=await qrFile();if(navigator.share&&navigator.canShare&&navigator.canShare({files:[file]})){await navigator.share({title:'GhostLane™ QR Code',text:'Scan to open GhostLane™',files:[file]})}else{downloadQr()}}catch(e){if(e?.name!=='AbortError')downloadQr()}
  }
  function downloadQr(){const a=document.createElement('a');a.href=QR_URL;a.download='GhostLane-QR.svg';document.body.appendChild(a);a.click();a.remove()}
  document.getElementById('gl-share-app').onclick=shareApp; document.getElementById('gl-share-qr').onclick=shareQr; document.getElementById('gl-download-qr').onclick=downloadQr;
})();