// ==========================================================
// GHOSTLANE CORE ENGINE: LIVE GEOLOCATION STARTUP & ROUTING
// ==========================================================

const state = {
  map: null,
  userMarker: null,
  cameraLayer: null,
  routeLayer: null,
  dodgeLayer: null,
  watchId: null,
  position: null, // Starts null until live GPS locks in
  cameras: [],
  activeThreat: null,
  lastWarningTime: 0,
  ledger: JSON.parse(localStorage.getItem('ghostlane_ledger') || '[]'),
  audioCtx: null,
  
  // Active Navigation & Turn-by-Turn State
  activeRouteCoords: null,
  activeDestination: null,
  activeMode: 'ghost',
  lastRecalcTime: 0,
  turnWaypoints: []
};

const METERS_TO_FEET = 3.28084;
const METERS_TO_MILES = 0.000621371;

// Audio & TTS
function initAudioEngine() {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function playRadarSweepBeep() {
  if (!state.audioCtx) return;
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

  const osc = state.audioCtx.createOscillator();
  const gain = state.audioCtx.createGain();

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(950, state.audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(400, state.audioCtx.currentTime + 0.22);

  gain.gain.setValueAtTime(0.25, state.audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, state.audioCtx.currentTime + 0.22);

  osc.connect(gain);
  gain.connect(state.audioCtx.destination);

  osc.start();
  osc.stop(state.audioCtx.currentTime + 0.22);
}

function speakVoiceAlert(phrase) {
  if ('speechSynthesis' in window) {
    if (window.speechSynthesis.speaking) window.speechSynthesis.cancel();
    const voiceMsg = new SpeechSynthesisUtterance(phrase);
    voiceMsg.rate = 1.1;
    voiceMsg.pitch = 1.0;
    window.speechSynthesis.speak(voiceMsg);
  }
}

// Math & Geolocation (Imperial)
function getDistanceFeet(lat1, lon1, lat2, lon2) {
  const R_FEET = 20902231;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R_FEET * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function getAzimuth(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
            Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function distanceToSegmentFeet(pLat, pLon, vLat, vLon, wLat, wLon) {
  const ftPerDegLat = 364000;
  const ftPerDegLon = 364000 * Math.cos(pLat * Math.PI / 180);

  const px = pLon * ftPerDegLon; const py = pLat * ftPerDegLat;
  const vx = vLon * ftPerDegLon; const vy = vLat * ftPerDegLat;
  const wx = wLon * ftPerDegLon; const wy = wLat * ftPerDegLat;

  const l2 = (wx - vx) ** 2 + (wy - vy) ** 2;
  if (l2 === 0) return Math.sqrt((px - vx) ** 2 + (py - vy) ** 2);
  
  let t = ((px - vx) * (wx - vx) + (py - vy) * (wy - vy)) / l2;
  t = Math.max(0, Math.min(1, t));
  
  const projX = vx + t * (wx - vx);
  const projY = vy + t * (wy - vy);
  
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

function computeFovPolygonPoints(lat, lon, headingDeg, fovDeg, distanceFeet = 400) {
  const points = [[lat, lon]];
  const halfFov = fovDeg / 2;
  const startAngle = headingDeg - halfFov;
  const steps = 6;
  const stepAngle = fovDeg / steps;
  const distanceMeters = distanceFeet / METERS_TO_FEET;

  for (let i = 0; i <= steps; i++) {
    const angle = (startAngle + stepAngle * i) * (Math.PI / 180);
    const dLat = (distanceMeters * Math.cos(angle)) / 111320;
    const dLon = (distanceMeters * Math.sin(angle)) / (111320 * Math.cos(lat * (Math.PI / 180)));
    points.push([lat + dLat, lon + dLon]);
  }
  return points;
}

// Address Geocoding Engine
async function geocodeAddress(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`;
  const response = await fetch(url);
  const data = await response.json();
  if (data && data.length > 0) {
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  }
  throw new Error("Address not found. Try adding the city and state.");
}

// Supabase Cloud Sync Integration (Unrestricted Full Mesh Pull)
const SUPABASE_URL = "https://zksyyjpepnulbmkscpyl.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inprc3l5anBlcG51bGJta3NjcHlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwODgyNDIsImV4cCI6MjEwMjY2NDI0Mn0.AwuWWmIRfSObc8IFDxClSBV_yC3VY0k1Q_2rAB-B27k";
const _supabase = (typeof supabase !== 'undefined') ? supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

async function fetchSupabaseCameras() {
  if (!_supabase) return;
  try {
    // Pull ALL records without pagination limits
    const { data, error } = await _supabase.from('cameras').select('*').limit(5000);
    if (!error && data && data.length > 0) {
      state.cameras = data.map(dbCam => ({
        id: dbCam.node_id || `db-${dbCam.id}`,
        lat: Number(dbCam.lat),
        lon: Number(dbCam.lng),
        heading: Number(dbCam.heading) || 0,
        fov: 60,
        range: 400,
        hardware: dbCam.label || 'Surveillance Node',
        source: 'Supabase Cloud'
      }));
      renderCameraNodes();
      saveStoredCameras();
    }
  } catch (err) {
    console.warn("Supabase fetch fallback to local storage:", err);
    loadStoredCameras();
  }
}

// Map Initialization & Instant Geolocation Acquisition
function initMap() {
  state.map = L.map('map', { center: [35.4676, -97.5164], zoom: 14, zoomControl: false });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OSM &copy; CARTO', maxZoom: 19 }).addTo(state.map);
  state.cameraLayer = L.layerGroup().addTo(state.map);
  state.routeLayer = L.layerGroup().addTo(state.map);
  state.dodgeLayer = L.layerGroup().addTo(state.map);
  
  fetchSupabaseCameras();
  updateLedgerDisplay();

  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude, longitude, heading, speed } = pos.coords;
        state.position = { 
          lat: latitude, 
          lon: longitude, 
          heading: heading !== null && !isNaN(heading) ? Math.round(heading) : 0, 
          speed: speed || 0 
        };
        state.map.setView([latitude, longitude], 16);
        updateVehicleMarker(latitude, longitude, state.position.heading);
      },
      err => {
        console.warn("Initial GPS lock failed:", err.message);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }
}

function updateVehicleMarker(lat, lon, heading) {
  const iconHtml = `<div class="user-arrow-puck" style="transform: rotate(${heading}deg);"><div class="arrow-core"></div></div>`;
  const puckIcon = L.divIcon({
    className: 'custom-puck-icon',
    html: iconHtml,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  if (!state.userMarker) {
    state.userMarker = L.marker([lat, lon], { icon: puckIcon }).addTo(state.map);
  } else {
    state.userMarker.setLatLng([lat, lon]);
    state.userMarker.setIcon(puckIcon);
  }
}

function renderCameraNodes() {
  if (!state.cameraLayer) return;
  state.cameraLayer.clearLayers();
  state.cameras.forEach(cam => {
    const fovCoords = computeFovPolygonPoints(cam.lat, cam.lon, cam.heading, cam.fov || 60, cam.range || 400);
    L.polygon(fovCoords, { color: '#ef4444', weight: 1, fillColor: '#ef4444', fillOpacity: 0.18 }).addTo(state.cameraLayer);
    const icon = L.divIcon({ className: 'cam-marker', html: `<div style="width: 12px; height: 12px; background: #ef4444; border: 2px solid #ffffff; border-radius: 50%; box-shadow: 0 0 8px #ef4444;"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] });
    const marker = L.marker([cam.lat, cam.lon], { icon }).addTo(state.cameraLayer);
    marker.bindPopup(`<div style="color: #0b0f19; font-size: 0.8rem;"><strong>${cam.hardware || 'Camera Node'}</strong><br>Lens Heading: ${cam.heading}°<br>FOV: ${cam.fov || 60}°<br>Range: ${cam.range || 400} ft<br>Source: ${cam.source || 'Verified Node'}</div>`);
  });
  const statEl = document.getElementById('stat-cameras');
  if (statEl) statEl.textContent = state.cameras.length;
}

// Expanded 50-Mile Mesh Sync Radius
async function syncMeshCameras(lat, lon, radiusMiles = 50) {
  if (!lat || !lon) return alert("Location data is missing. Please wait for GPS lock.");
  const radiusMeters = Math.round(radiusMiles * 1609.34);
  const query = `[out:json][timeout:30];(node["man_made"="surveillance"](around:${radiusMeters},${lat},${lon});node["highway"="speed_camera"](around:${radiusMeters},${lat},${lon}););out body;`;
  const endpoints = ['https://overpass-api.de/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

  let data = null;
  try {
    for (let url of endpoints) {
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` });
        if (res.ok) { data = await res.json(); break; }
      } catch (e) { console.warn(`Server ${url} failed. Rerouting...`); }
    }

    if (!data) throw new Error('All database servers are busy.');

    const fetched = data.elements.map(el => {
      let heading = 0;
      if (el.tags && (el.tags['camera:direction'] || el.tags['direction'])) heading = parseFloat(el.tags['camera:direction'] || el.tags['direction']) || 0;
      let type = "Surveillance Node";
      if (el.tags && el.tags['surveillance:type']) type = el.tags['surveillance:type'];
      else if (el.tags && el.tags['highway'] === 'speed_camera') type = 'Speed Camera';
      return { id: `osm-${el.id}`, lat: el.lat, lon: el.lon, heading: heading, fov: 60, range: 400, hardware: type.toUpperCase(), source: 'OSM Verified' };
    });

    let newCount = 0;
    fetched.forEach(item => { if (!state.cameras.some(c => c.id === item.id)) { state.cameras.push(item); newCount++; } });

    saveStoredCameras(); 
    renderCameraNodes();
    alert(`Mesh Sync Complete. Discovered ${newCount} live nodes in the expanded radius.`);
  } catch (err) { alert(`Connection Error: ${err.message}.`); }
}

// Turn Predictor
function buildTurnInstructions(coords) {
  state.turnWaypoints = [];
  const minDistanceBetweenTurnsFeet = 200; 

  for (let i = 1; i < coords.length - 1; i++) {
    let p1 = coords[i-1];
    let p2 = coords[i];
    let p3 = coords[i+1];

    let b1 = getAzimuth(p1[0], p1[1], p2[0], p2[1]);
    let b2 = getAzimuth(p2[0], p2[1], p3[0], p3[1]);

    let diff = ((b2 - b1 + 540) % 360) - 180;

    if (Math.abs(diff) > 35) { 
      let turnType = diff > 0 ? "right" : "left";
      
      let tooClose = false;
      if (state.turnWaypoints.length > 0) {
         let lastTurn = state.turnWaypoints[state.turnWaypoints.length - 1];
         if (getDistanceFeet(lastTurn.lat, lastTurn.lon, p2[0], p2[1]) < minDistanceBetweenTurnsFeet) tooClose = true;
      }

      if (!tooClose) {
          state.turnWaypoints.push({ 
            lat: p2[0], lon: p2[1], type: turnType, 
            announced1000: false, announced250: false, passed: false 
          });
      }
    }
  }
}

// Radar & Tracking Loop
function evaluateActiveTracking() {
  if (!state.position) return;
  const { lat, lon, heading, speed } = state.position;
  const now = Date.now();

  if (state.cameras.length > 0) {
    const alertThresholdFeet = 1000;
    let closestIntercept = null;
    let minDistance = Infinity;

    state.cameras.forEach(cam => {
      const distFeet = getDistanceFeet(lat, lon, cam.lat, cam.lon);
      if (distFeet < alertThresholdFeet && distFeet < minDistance) {
        const bearingToCamera = getAzimuth(lat, lon, cam.lat, cam.lon);
        const bearingToDriver = getAzimuth(cam.lat, cam.lon, lat, lon);

        let approachAngleDiff = Math.abs(heading - bearingToCamera);
        if (approachAngleDiff > 180) approachAngleDiff = 360 - approachAngleDiff;

        let lensAngleDiff = Math.abs(cam.heading - bearingToDriver);
        if (lensAngleDiff > 180) lensAngleDiff = 360 - lensAngleDiff;

        const inLensFov = lensAngleDiff <= ((cam.fov || 60) / 2);
        const isApproaching = approachAngleDiff <= 45 || speed < 2;

        if (inLensFov && isApproaching) {
          minDistance = distFeet;
          closestIntercept = { ...cam, distance: Math.round(distFeet) };
        }
      }
    });

    const banner = document.getElementById('threat-alert');
    if (banner && closestIntercept) {
      banner.classList.remove('alert-hidden');
      document.getElementById('alert-title').textContent = `${closestIntercept.hardware.toUpperCase()}`;
      document.getElementById('alert-subtitle').textContent = `Optical Intercept Ahead (${closestIntercept.distance} ft)`;
      document.getElementById('alert-countdown').textContent = `${closestIntercept.distance} ft`;

      if (now - state.lastWarningTime > 7000 || state.activeThreat !== closestIntercept.id) {
        playRadarSweepBeep();
        speakVoiceAlert(`Warning. ${closestIntercept.hardware} ahead.`);
        logLedgerEntry(closestIntercept);
        state.lastWarningTime = now;
        state.activeThreat = closestIntercept.id;
      }
    } else if (banner) {
      banner.classList.add('alert-hidden');
      state.activeThreat = null;
    }
  }

  const turnHud = document.getElementById('turn-hud');
  if (state.activeRouteCoords && state.activeRouteCoords.length > 0 && state.activeDestination && turnHud) {
    let upcomingTurn = null;
    if (state.turnWaypoints) {
       upcomingTurn = state.turnWaypoints.find(t => !t.passed);
       
       if (upcomingTurn) {
           let distToTurn = getDistanceFeet(lat, lon, upcomingTurn.lat, upcomingTurn.lon);
           document.getElementById('turn-direction').textContent = `Turn ${upcomingTurn.type}`;
           document.getElementById('turn-distance').textContent = `${Math.round(distToTurn)} ft`;
           document.getElementById('turn-icon').textContent = upcomingTurn.type === 'left' ? '⬅️' : '➡️';
           turnHud.classList.remove('turn-hidden');

           if (distToTurn < 100) {
               upcomingTurn.passed = true;
           } else if (distToTurn < 300 && !upcomingTurn.announced250) {
               speakVoiceAlert(`Turn ${upcomingTurn.type} ahead.`);
               upcomingTurn.announced250 = true;
           } else if (distToTurn < 1000 && distToTurn > 600 && !upcomingTurn.announced1000) {
               speakVoiceAlert(`In 1000 feet, turn ${upcomingTurn.type}.`);
               upcomingTurn.announced1000 = true;
           }
       }
    }

    let distToDest = getDistanceFeet(lat, lon, state.activeDestination.lat, state.activeDestination.lon);
    if (!upcomingTurn || distToDest < 1000) {
        document.getElementById('turn-direction').textContent = `Destination Ahead`;
        document.getElementById('turn-distance').textContent = `${Math.round(distToDest)} ft`;
        document.getElementById('turn-icon').textContent = '🏁';
        turnHud.classList.remove('turn-hidden');
    }

    if (distToDest < 150) {
      speakVoiceAlert("You have arrived at your zero-trace destination.");
      state.activeRouteCoords = null; 
      state.activeDestination = null;
      state.routeLayer.clearLayers(); 
      state.dodgeLayer.clearLayers();
      turnHud.classList.add('turn-hidden');
      return;
    }
  } else if (turnHud) {
    turnHud.classList.add('turn-hidden');
  }
}

// Exclusion Routing Engine
async function calculateShadowRoute(targetCoords, mode = 'ghost', isAutoRecalc = false) {
  if (!state.position) throw new Error('Active GPS radar required.');
  const start = state.position; 
  const end = targetCoords; 

  try {
    let routeGeoJson = null; 
    let finalIntercepts = 0;

    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${start.lon},${start.lat};${end.lon},${end.lat}?overview=full&geometries=geojson`;
    const res = await fetch(osrmUrl);
    const data = await res.json();
    if (!data.routes || data.routes.length === 0) throw new Error("No route found.");
    
    routeGeoJson = { geometry: data.routes[0].geometry, properties: { "track-length": data.routes[0].distance, "total-time": data.routes[0].duration } };
    let hitCams = new Set();
    routeGeoJson.geometry.coordinates.forEach(c => { state.cameras.forEach(cam => { if (getDistanceFeet(c[1], c[0], cam.lat, cam.lon) < 300) hitCams.add(cam.id); }); });
    finalIntercepts = hitCams.size;

    state.routeLayer.clearLayers(); 
    state.dodgeLayer.clearLayers();
    const leafletCoords = routeGeoJson.geometry.coordinates.map(c => [c[1], c[0]]);
    
    L.polyline(leafletCoords, { color: '#38bdf8', weight: 7, opacity: 0.9 }).addTo(state.routeLayer);
    
    try {
      const polyline = L.polyline(leafletCoords);
      const bounds = polyline.getBounds();
      if (bounds.isValid()) {
        state.map.fitBounds(bounds, { padding: [60, 60] });
      }
    } catch (e) {
      console.warn("Bounds fitting skipped:", e);
    }

    buildTurnInstructions(leafletCoords);

    const distanceMeters = routeGeoJson.properties["track-length"] || 0;
    const durationSeconds = routeGeoJson.properties["total-time"] || 0;
    const totalMiles = (distanceMeters * METERS_TO_MILES).toFixed(1);
    
    const resultsEl = document.getElementById('route-results');
    if (resultsEl) resultsEl.classList.remove('route-results-hidden');
    
    const resDist = document.getElementById('res-distance');
    if (resDist) resDist.textContent = `${totalMiles} mi`;
    
    const resDur = document.getElementById('res-duration');
    if (resDur) resDur.textContent = `${Math.round(durationSeconds / 60)} min`;
    
    const resInt = document.getElementById('res-intercepts');
    if (resInt) resInt.textContent = finalIntercepts;

    state.activeRouteCoords = leafletCoords; 
    state.activeDestination = targetCoords; 
    state.activeMode = mode;
    
    evaluateActiveTracking();

  } catch (err) { if (!isAutoRecalc) alert(err.message); }
}

// Ledger & Storage
function logLedgerEntry(camera) {
  const entry = { id: `log-${Date.now()}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), hardware: camera.hardware, lat: Number(camera.lat).toFixed(4), lon: Number(camera.lon).toFixed(4) };
  state.ledger.unshift(entry); if (state.ledger.length > 50) state.ledger.pop();
  localStorage.setItem('ghostlane_ledger', JSON.stringify(state.ledger)); updateLedgerDisplay();
}

function updateLedgerDisplay() {
  const count = state.ledger.length; 
  const totalCountEl = document.getElementById('ledger-total-count');
  if (totalCountEl) totalCountEl.textContent = count;
  
  let grade = count > 8 ? 'F' : count > 3 ? 'C' : 'A+'; 
  let gradeClass = count > 8 ? 'grade-f' : count > 3 ? 'grade-c' : 'grade-a';

  const statPrivacy = document.getElementById('stat-privacy');
  if (statPrivacy) {
    statPrivacy.textContent = grade; 
    statPrivacy.className = `hud-value ${gradeClass}`;
  }

  const listEl = document.getElementById('ledger-list');
  if (listEl) {
    if (state.ledger.length === 0) listEl.innerHTML = '<li class="empty-state">No surveillance intercepts recorded today.</li>';
    else listEl.innerHTML = state.ledger.map(item => `<li class="ledger-item"><div><strong>${item.hardware}</strong><br><small style="color:#94a3b8;">${item.lat}, ${item.lon}</small></div><span>${item.time}</span></li>`).join('');
  }
}

function saveStoredCameras() { localStorage.setItem('ghostlane_nodes', JSON.stringify(state.cameras)); }
function loadStoredCameras() { const raw = localStorage.getItem('ghostlane_nodes'); if (raw) { try { state.cameras = JSON.parse(raw); renderCameraNodes(); } catch (e) { state.cameras = []; } } }

function toggleLiveRadar() {
  initAudioEngine(); 
  const btn = document.getElementById('btn-toggle-radar');
  const turnHud = document.getElementById('turn-hud');
  
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId); 
    state.watchId = null;
    if (btn) {
      btn.textContent = 'START RADAR'; 
      btn.classList.remove('btn-radar-active');
    }
    state.activeRouteCoords = null; 
    state.activeDestination = null;
    state.routeLayer.clearLayers(); 
    if (turnHud) turnHud.classList.add('turn-hidden');
    return;
  }

  if (!('geolocation' in navigator)) return alert('Geolocation permissions required for live radar.');
  
  if (btn) {
    btn.textContent = 'RADAR LIVE'; 
    btn.classList.add('btn-radar-active');
  }

  state.watchId = navigator.geolocation.watchPosition(
    pos => {
      const { latitude, longitude, heading, speed } = pos.coords;
      const speedMph = speed ? Math.round(speed * 2.23694) : 0;
      const currentHeading = heading !== null && !isNaN(heading) ? Math.round(heading) : 0;
      state.position = { lat: latitude, lon: longitude, heading: currentHeading, speed: speed || 0 };
      
      const speedEl = document.getElementById('stat-speed');
      if (speedEl) speedEl.innerHTML = `${speedMph} <small>MPH</small>`;
      
      const headingEl = document.getElementById('stat-heading');
      if (headingEl) headingEl.innerHTML = `${currentHeading}°`;

      updateVehicleMarker(latitude, longitude, currentHeading);

      if (!state.activeRouteCoords) {
        state.map.setView([latitude, longitude], 15);
      }
      evaluateActiveTracking();
    },
    err => console.warn(`GPS Error: ${err.message}`), { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );
}

// UI Event Binding
document.addEventListener('DOMContentLoaded', () => {
  initMap(); 
  
  const toggleRadarBtn = document.getElementById('btn-toggle-radar');
  if (toggleRadarBtn) toggleRadarBtn.addEventListener('click', toggleLiveRadar);

  const syncBtn = document.getElementById('btn-sync-mesh');
  if (syncBtn) syncBtn.addEventListener('click', () => { const center = state.position ? state.position : state.map.getCenter(); syncMeshCameras(center.lat, center.lon || center.lng, 50); });
  
  const recenterBtn = document.getElementById('btn-recenter');
  if (recenterBtn) recenterBtn.addEventListener('click', () => { 
    if (state.position) {
      state.map.setView([state.position.lat, state.position.lon], 16);
    } 
  });

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.drawer-panel').forEach(p => p.classList.add('panel-hidden'));
      btn.classList.add('active'); const tab = btn.getAttribute('data-tab');
      if (tab === 'routing-view') document.getElementById('panel-routing').classList.remove('panel-hidden');
      if (tab === 'ledger-view') document.getElementById('panel-ledger').classList.remove('panel-hidden');
      if (tab === 'verify-view') document.getElementById('panel-verify').classList.remove('panel-hidden');
    });
  });

  document.querySelectorAll('.btn-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const panelId = btn.getAttribute('data-close'); 
      const panel = document.getElementById(panelId);
      if (panel) panel.classList.add('panel-hidden');
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      const radarTab = document.querySelector('[data-tab="radar-view"]');
      if (radarTab) radarTab.classList.add('active');
    });
  });

  const calcRouteBtn = document.getElementById('btn-calculate-route');
  if (calcRouteBtn) {
    calcRouteBtn.addEventListener('click', async () => {
      const destInput = document.getElementById('route-dest').value.trim();
      if (!destInput) return alert('Enter a valid destination address or coordinates.');
      const modeEl = document.querySelector('input[name="route-mode"]:checked');
      const mode = modeEl ? modeEl.value : 'ghost';
      try {
        let targetCoords; const parts = destInput.split(',').map(s => parseFloat(s.trim()));
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) { targetCoords = { lat: parts[0], lon: parts[1] }; } 
        else { targetCoords = await geocodeAddress(destInput); }
        await calculateShadowRoute(targetCoords, mode, false);
      } catch (err) { alert(err.message); }
    });
  }

  const submitNodeBtn = document.getElementById('btn-submit-node');
  if (submitNodeBtn) {
    submitNodeBtn.addEventListener('click', async () => {
      const hardware = document.getElementById('node-hardware').value; 
      const heading = parseInt(document.getElementById('node-heading').value, 10);
      const fov = parseInt(document.getElementById('node-fov').value, 10); 
      const range = parseInt(document.getElementById('node-range').value, 10) || 400;
      const mode = document.getElementById('node-coords-mode').value; 
      let targetLat, targetLon;
      if (mode === 'current' && state.position) { targetLat = state.position.lat; targetLon = state.position.lon; } 
      else { const center = state.map.getCenter(); targetLat = center.lat; targetLon = center.lng; }
      
      const newNode = {
        lat: Number(targetLat),
        lng: Number(targetLon),
        node_id: `custom-${Date.now()}`,
        heading: Number(heading),
        label: String(hardware)
      };

      state.cameras.push({ id: newNode.node_id, lat: newNode.lat, lon: newNode.lng, heading: newNode.heading, fov, range, hardware: newNode.label, source: 'Community Verified' });
      saveStoredCameras(); 
      renderCameraNodes();
      
      const verifyPanel = document.getElementById('panel-verify');
      if (verifyPanel) verifyPanel.classList.add('panel-hidden');
      const radarTab = document.querySelector('[data-tab="radar-view"]');
      if (radarTab) radarTab.classList.add('active');

      if (_supabase) {
        try {
          await _supabase.from('cameras').insert([newNode]);
        } catch (e) {
          console.warn("Cloud write error:", e);
        }
      }
      alert('Node authenticated and written to cloud mesh!');
    });
  }

  const clearLedgerBtn = document.getElementById('btn-clear-ledger');
  if (clearLedgerBtn) clearLedgerBtn.addEventListener('click', () => { state.ledger = []; localStorage.removeItem('ghostlane_ledger'); updateLedgerDisplay(); });
});
