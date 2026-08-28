/* Cactus🌵Byte Studios™ — Demo & Help Standard v1.1
   Timed in-app demo player. No service worker. No autoplay audio. Generic scene renderer. */
(function(){
  if(window.__cactusByteDemoInstalled)return;
  window.__cactusByteDemoInstalled=true;
  var cfg=window.CACTUSBYTE_DEMO||{};
  if(!cfg.appId||!cfg.appName)return;

  var demoVersion=String(cfg.demoVersion||'1');
  var seenKey='cbs_demo_seen:'+cfg.appId+':'+demoVersion;
  var dismissedKey='cbs_demo_dismissed:'+cfg.appId+':'+demoVersion;
  var esc=function(value){return String(value==null?'':value).replace(/[&<>"']/g,function(mark){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[mark];});};

  var css=[
    '.cbs-demo-trigger{display:grid;place-items:center;min-width:42px;height:42px;padding:0 12px;border-radius:12px;border:1px solid rgba(56,189,248,.32);background:rgba(15,23,42,.88);color:#e2e8f0;font-weight:900;cursor:pointer}',
    '.cbs-demo-backdrop{position:fixed;z-index:10000;inset:0;background:rgba(2,6,23,.88);display:none;align-items:flex-end;justify-content:center}',
    '.cbs-demo-backdrop.open{display:flex}.cbs-demo-panel{width:min(100%,760px);max-height:94vh;overflow:auto;background:#070b19;color:#f8fafc;border:1px solid rgba(56,189,248,.28);border-bottom:0;border-radius:26px 26px 0 0;padding:18px 16px calc(24px + env(safe-area-inset-bottom));box-shadow:0 -24px 70px rgba(0,0,0,.62)}',
    '.cbs-demo-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.cbs-demo-head h2{margin:0;font-size:21px}.cbs-demo-close{width:40px;height:40px;border-radius:50%;border:1px solid rgba(148,163,184,.25);background:#111827;color:#fff;font-size:22px;cursor:pointer}',
    '.cbs-demo-sub{color:#94a3b8;font-size:12px;line-height:1.5;margin:7px 0 13px}',
    '.cbs-player{position:relative;overflow:hidden;border:1px solid rgba(56,189,248,.32);border-radius:20px;background:radial-gradient(circle at 50% 0%,rgba(14,165,233,.2),transparent 48%),#020617;min-height:318px;box-shadow:inset 0 0 50px rgba(14,165,233,.05)}',
    '.cbs-player-stage{min-height:268px;padding:20px 18px 16px;display:flex;flex-direction:column;justify-content:center;opacity:1;transform:translateY(0);transition:opacity .28s ease,transform .28s ease}.cbs-player-stage.swap{opacity:0;transform:translateY(8px)}',
    '.cbs-player-brand{display:flex;align-items:center;gap:10px;margin-bottom:14px}.cbs-player-brand img{width:38px;height:38px;border-radius:10px;object-fit:cover}.cbs-player-brand span{font-size:11px;letter-spacing:.12em;color:#7dd3fc;font-weight:900;text-transform:uppercase}',
    '.cbs-player-kicker{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#10b981;font-weight:900}.cbs-player-title{font-size:26px;line-height:1.08;margin:7px 0 8px}.cbs-player-copy{font-size:13px;line-height:1.55;color:#cbd5e1;margin:0;max-width:610px}',
    '.cbs-mock{display:grid;gap:8px;margin-top:16px}.cbs-mock-row{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}.cbs-mock-card{border:1px solid rgba(148,163,184,.17);background:rgba(15,23,42,.82);border-radius:13px;padding:10px}.cbs-mock-card b{display:block;color:#38bdf8;font-size:15px}.cbs-mock-card small{color:#94a3b8;font-size:9px}.cbs-mock-action{border-radius:13px;padding:11px 12px;text-align:center;background:linear-gradient(135deg,#38bdf8,#10b981);color:#04111d;font-weight:900;font-size:12px}.cbs-mock-evidence{display:flex;gap:7px;flex-wrap:wrap}.cbs-mock-pill{padding:7px 9px;border-radius:999px;background:#0f172a;border:1px solid rgba(56,189,248,.24);font-size:9px;color:#bae6fd}',
    '.cbs-player-controls{border-top:1px solid rgba(148,163,184,.14);padding:10px 12px 12px;background:rgba(2,6,23,.82)}.cbs-progress{height:5px;background:#172033;border-radius:999px;overflow:hidden}.cbs-progress-bar{height:100%;width:0;background:linear-gradient(90deg,#38bdf8,#10b981);transition:width .2s linear}.cbs-controls-row{display:flex;align-items:center;gap:9px;margin-top:9px}.cbs-play{border:0;border-radius:10px;padding:8px 12px;background:#e2e8f0;color:#07101f;font-weight:900;cursor:pointer}.cbs-time{font-variant-numeric:tabular-nums;color:#94a3b8;font-size:11px}.cbs-scene-count{margin-left:auto;color:#64748b;font-size:10px}',
    '.cbs-demo-steps{display:grid;gap:9px;margin-top:14px}.cbs-demo-step{border:1px solid rgba(148,163,184,.18);border-radius:16px;padding:13px;background:#0b1224}.cbs-demo-step strong{display:block;font-size:13px;color:#38bdf8}.cbs-demo-step span{display:block;color:#cbd5e1;font-size:11px;line-height:1.45;margin-top:4px}',
    '.cbs-demo-actions{display:flex;gap:9px;margin-top:14px}.cbs-demo-actions button{flex:1;border:0;border-radius:14px;padding:13px;font-weight:900;cursor:pointer}.cbs-demo-primary{background:linear-gradient(135deg,#38bdf8,#10b981);color:#04111d}.cbs-demo-secondary{background:#111827!important;color:#f8fafc;border:1px solid rgba(148,163,184,.22)!important}.cbs-demo-check{display:flex;align-items:flex-start;gap:9px;color:#94a3b8;font-size:11px;line-height:1.4;margin-top:13px}',
    '@media(max-width:520px){.cbs-player{min-height:340px}.cbs-player-stage{min-height:290px}.cbs-player-title{font-size:23px}.cbs-mock-row{grid-template-columns:repeat(2,1fr)}}',
    '@media(min-width:700px){.cbs-demo-backdrop{align-items:center;padding:24px}.cbs-demo-panel{border-bottom:1px solid rgba(56,189,248,.28);border-radius:26px}}'
  ].join('');
  var style=document.createElement('style');
  style.textContent=css;
  document.head.appendChild(style);

  var backdrop=document.createElement('div');
  backdrop.className='cbs-demo-backdrop';
  backdrop.innerHTML='<section class="cbs-demo-panel" role="dialog" aria-modal="true" aria-labelledby="cbsDemoTitle">'+
    '<div class="cbs-demo-head"><h2 id="cbsDemoTitle">How to use '+esc(cfg.appName)+'</h2><button class="cbs-demo-close" aria-label="Close">×</button></div>'+
    '<p class="cbs-demo-sub">'+esc(cfg.intro||'A fast guided walkthrough.')+'</p>'+
    '<div class="cbs-demo-media"></div>'+
    '<div class="cbs-demo-steps"></div>'+
    '<label class="cbs-demo-check"><input type="checkbox" class="cbs-demo-dontshow"><span>Don’t show this automatically again for this demo version. Help stays available from the top bar.</span></label>'+
    '<div class="cbs-demo-actions"><button class="cbs-demo-secondary cbs-demo-skip">Close</button><button class="cbs-demo-primary cbs-demo-start">Start using '+esc(cfg.appName)+'</button></div>'+
    '</section>';
  document.body.appendChild(backdrop);

  var timeline=Array.isArray(cfg.timeline)?cfg.timeline:[];
  var duration=timeline.reduce(function(total,scene){return total+(Number(scene.duration)||0);},0)||60;
  var elapsed=0;
  var playing=false;
  var timer=null;
  var activeScene=-1;
  var media=backdrop.querySelector('.cbs-demo-media');

  function mockup(scene){
    var cards=Array.isArray(scene.cards)?scene.cards:[];
    var html='<div class="cbs-mock">';
    if(cards.length){
      html+='<div class="cbs-mock-row">'+cards.map(function(card){
        return '<div class="cbs-mock-card"><small>'+esc(card.label||'')+'</small><b>'+esc(card.value||'')+'</b></div>';
      }).join('')+'</div>';
    }
    if(scene.action)html+='<div class="cbs-mock-action">'+esc(scene.action)+'</div>';
    if(Array.isArray(scene.pills)&&scene.pills.length){
      html+='<div class="cbs-mock-evidence">'+scene.pills.map(function(pill){return '<span class="cbs-mock-pill">'+esc(pill)+'</span>';}).join('')+'</div>';
    }
    return html+'</div>';
  }

  function sceneAt(seconds){
    var cursor=0;
    for(var i=0;i<timeline.length;i++){
      cursor+=Number(timeline[i].duration)||0;
      if(seconds<cursor||i===timeline.length-1)return i;
    }
    return 0;
  }

  function renderScene(index){
    if(!timeline.length)return;
    var scene=timeline[index]||timeline[0];
    var stage=media.querySelector('.cbs-player-stage');
    if(!stage)return;
    stage.classList.add('swap');
    setTimeout(function(){
      stage.innerHTML='<div class="cbs-player-brand"><img src="'+esc(cfg.logoUrl||'/logo1.jpg')+'" alt=""><span>60-second demo</span></div>'+
        '<div class="cbs-player-kicker">'+esc(scene.kicker||'MachZero')+'</div>'+
        '<h3 class="cbs-player-title">'+esc(scene.title||'')+'</h3>'+
        '<p class="cbs-player-copy">'+esc(scene.text||'')+'</p>'+
        mockup(scene);
      stage.classList.remove('swap');
    },180);
    activeScene=index;
    var count=media.querySelector('.cbs-scene-count');
    if(count)count.textContent=(index+1)+' / '+timeline.length;
  }

  function formatTime(seconds){
    var value=Math.max(0,Math.min(duration,Math.floor(seconds)));
    return '0:'+String(value).padStart(2,'0')+' / 1:00';
  }

  function updatePlayer(){
    var index=sceneAt(elapsed);
    if(index!==activeScene)renderScene(index);
    var bar=media.querySelector('.cbs-progress-bar');
    var time=media.querySelector('.cbs-time');
    if(bar)bar.style.width=Math.min(100,(elapsed/duration)*100)+'%';
    if(time)time.textContent=formatTime(elapsed);
  }

  function pause(){
    playing=false;
    if(timer){clearInterval(timer);timer=null;}
    var button=media.querySelector('.cbs-play');
    if(button)button.textContent=elapsed>=duration?'Replay':'Play';
  }

  function play(){
    if(!timeline.length)return;
    if(elapsed>=duration)elapsed=0;
    playing=true;
    var button=media.querySelector('.cbs-play');
    if(button)button.textContent='Pause';
    var last=Date.now();
    timer=setInterval(function(){
      var now=Date.now();
      elapsed+=(now-last)/1000;
      last=now;
      if(elapsed>=duration){elapsed=duration;updatePlayer();pause();localStorage.setItem(seenKey,'1');return;}
      updatePlayer();
    },200);
  }

  if(timeline.length){
    media.innerHTML='<div class="cbs-player"><div class="cbs-player-stage"></div><div class="cbs-player-controls"><div class="cbs-progress"><div class="cbs-progress-bar"></div></div><div class="cbs-controls-row"><button class="cbs-play" type="button">Play</button><span class="cbs-time">0:00 / 1:00</span><span class="cbs-scene-count"></span></div></div></div>';
    media.querySelector('.cbs-play').onclick=function(){playing?pause():play();};
    renderScene(0);
    updatePlayer();
  }else{
    media.innerHTML='<div class="cbs-player"><div class="cbs-player-stage"><h3 class="cbs-player-title">Walkthrough ready</h3><p class="cbs-player-copy">Use the written steps below.</p></div></div>';
  }

  var steps=Array.isArray(cfg.steps)?cfg.steps:[];
  backdrop.querySelector('.cbs-demo-steps').innerHTML=steps.map(function(step,index){
    return '<div class="cbs-demo-step"><strong>'+(index+1)+'. '+esc(step.title||'Step')+'</strong><span>'+esc(step.text||'')+'</span></div>';
  }).join('');

  function close(){
    pause();
    if(backdrop.querySelector('.cbs-demo-dontshow').checked)localStorage.setItem(dismissedKey,'1');
    backdrop.classList.remove('open');
    document.body.style.overflow='';
  }
  function open(auto){
    backdrop.classList.add('open');
    document.body.style.overflow='hidden';
    if(auto)localStorage.setItem(seenKey,'1');
  }

  backdrop.querySelector('.cbs-demo-close').onclick=close;
  backdrop.querySelector('.cbs-demo-skip').onclick=close;
  backdrop.addEventListener('click',function(event){if(event.target===backdrop)close();});
  backdrop.querySelector('.cbs-demo-start').onclick=function(){localStorage.setItem(seenKey,'1');close();cfg.onStart&&cfg.onStart();};

  var target=document.querySelector(cfg.triggerContainer||'.topbar')||document.body;
  var trigger=document.createElement('button');
  trigger.type='button';
  trigger.className='cbs-demo-trigger';
  trigger.textContent='Help';
  trigger.setAttribute('aria-label','How to use '+cfg.appName);
  trigger.onclick=function(){open(false);};
  target.appendChild(trigger);
  window.openCactusByteDemo=function(){open(false);};

  if(cfg.firstLaunch!==false&&localStorage.getItem(seenKey)!=='1'&&localStorage.getItem(dismissedKey)!=='1'){
    setTimeout(function(){open(true);},Number(cfg.autoDelayMs)||900);
  }
})();
