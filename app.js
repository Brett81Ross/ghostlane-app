// ==========================================================
// GHOSTLANE CORE ENGINE: GRID SWEEP ZERO-TRACE ALGORITHM
// ==========================================================

const state = {
  map: null,
  userMarker: null,
  cameraLayer: null,
  routeLayer: null,
  dodgeLayer: null,
  watchId: null,
  position: null,
  cameras: [],
  activeThreat: null,
  lastWarningTime: 0,
  ledger: JSON.parse(localStorage.getItem('ghostlane_ledger') || '[]'),
  audioCtx: null
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
    window.speechSynthesis.cancel();
    const voiceMsg = new SpeechSynthesisUtterance(phrase);
    voiceMsg.rate = 1.05;
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

// Generates a GPS coordinate offset by X feet at a specific bearing
function getDestinationPoint(lat, lon, bearing, distanceFeet) {
  const R_FEET = 20902231;
  const d = distanceFeet / R_FEET;
  const radLat = lat * Math.PI / 180;
  const radLon = lon * Math.PI / 180;
  const radBearing = bearing * Math.PI / 180;

  const newLat = Math.asin(Math.sin(radLat) * Math.cos(d) + Math.cos(radLat) * Math.sin(d) * Math.cos(radBearing));
  const newLon = radLon + Math.atan2(Math.sin(radBearing) * Math.sin(d) * Math.cos(radLat), Math.cos(d) - Math.sin(radLat) * Math.sin(newLat));

  return { lat: newLat * 180 / Math.PI, lon: newLon * 180 / Math.PI };
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

// Map Initialization
function initMap() {
  state.map = L.map('map', {
    center: [35.4676, -97.5164],
    zoom: 14,
    zoomControl: false
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &copy; CARTO',
    maxZoom: 19
  }).addTo(state.map);

  state.cameraLayer = L.layerGroup().addTo(state.map);
  state.routeLayer = L.layerGroup().addTo(state.map);
  state.dodgeLayer = L.layerGroup().addTo(state.map);

  loadStoredCameras();
  updateLedgerDisplay();
}

function renderCameraNodes() {
  state.cameraLayer.clearLayers();

  state.cameras.forEach(cam => {
    const fovCoords = computeFovPolygonPoints(cam.lat, cam.lon, cam.heading, cam.fov || 60, cam.range || 400);
    L.polygon(fovCoords, {
      color: '#ef4444',
      weight: 1,
      fillColor: '#ef4444',
      fillOpacity: 0.18
    }).addTo(state.cameraLayer);

    const icon = L.divIcon({
      className: 'cam-marker',
      html: `<div style="width: 12px; height: 12px; background: #ef4444; border: 2px solid #ffffff; border-radius: 50%; box-shadow: 0 0 8px #ef4444;"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });

    const marker = L.marker([cam.lat, cam.lon], { icon }).addTo(state.cameraLayer);
    marker.bindPopup(`
      <div style="color: #0b0f19; font-size: 0.8rem;">
        <strong>${cam.hardware || 'Camera Node'}</strong><br>
        Lens Heading: ${cam.heading}°<br>
        FOV: ${cam.fov || 60}°<br>
        Range: ${cam.range || 400} ft<br>
        Source: ${cam.source || 'Verified Node'}
      </div>
    `);
  });

  document.getElementById('stat-cams').textContent = state.cameras.length;
}

// Resilient Network Sync
async function syncMeshCameras(lat, lon, radiusMiles = 5) {
  if (!lat || !lon) {
    alert("Location data is missing. Please wait for map to load or tap START RADAR.");
    return;
  }

  const radiusMeters = Math.round(radiusMiles * 1609.34);
  const btn = document.getElementById('btn-sync-mesh');
  
  btn.style.opacity = '0.5';
  btn.style.pointerEvents = 'none';

  const query = `[out:json][timeout:25];(node["man_made"="surveillance"](around:${radiusMeters},${lat},${lon});node["highway"="speed_camera"](around:${radiusMeters},${lat},${lon}););out body;`;
  
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

  let data = null;

  try {
    for (let url of endpoints) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`
        });
        if (res.ok) {
          data = await res.json();
          break;
        }
      } catch (e) {
        console.warn(`Server ${url} failed. Rerouting...`);
      }
    }

    if (!data) throw new Error('All database servers are busy.');

    const fetched = data.elements.map(el => {
      let heading = 0;
      if (el.tags && (el.tags['camera:direction'] || el.tags['direction'])) {
        heading = parseFloat(el.tags['camera:direction'] || el.tags['direction']) || 0;
      }
      
      let type = "Surveillance Node";
      if (el.tags && el.tags['surveillance:type']) type = el.tags['surveillance:type'];
      else if (el.tags && el.tags['highway'] === 'speed_camera') type = 'Speed Camera';

      return {
        id: `osm-${el.id}`, lat: el.lat, lon: el.lon, heading: heading, fov: 60, range: 400,
        hardware: type.toUpperCase(), source: 'OSM Verified'
      };
    });

    let newCount = 0;
    fetched.forEach(item => {
      if (!state.cameras.some(c => c.id === item.id)) {
        state.cameras.push(item);
        newCount++;
      }
    });

    saveStoredCameras();
    renderCameraNodes();
    
    if (newCount > 0) alert(`Mesh Sync Complete. Discovered ${newCount} surveillance nodes.`);
    else alert(`Mesh Sync Complete. No new cameras found.`);
  } catch (err) {
    alert(`Connection Error: ${err.message}.`);
  } finally {
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
  }
}

// Radar Engine
function evaluateDirectionalAlerts() {
  if (!state.position || state.cameras.length === 0) return;

  const { lat, lon, heading, speed } = state.position;
  const alertThresholdFeet = 1000;
  const now = Date.now();

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

  if (closestIntercept) {
    banner.classList.remove('alert-hidden');
    document.getElementById('alert-title').textContent = `${closestIntercept.hardware.toUpperCase()}`;
    document.getElementById('alert-subtitle').textContent = `Optical Intercept Ahead (${closestIntercept.distance} ft)`;
    document.getElementById('alert-countdown').textContent = `${closestIntercept.distance} ft`;

    if (now - state.lastWarningTime > 7000 || state.activeThreat !== closestIntercept.id) {
      playRadarSweepBeep();
      speakVoiceAlert(`Warning. ${closestIntercept.hardware} ahead in ${closestIntercept.distance} feet.`);
      logLedgerEntry(closestIntercept);
      state.lastWarningTime = now;
      state.activeThreat = closestIntercept.id;
    }
  } else {
    banner.classList.add('alert-hidden');
    state.activeThreat = null;
  }
}

// NEW "GRID SWEEP" EVASION ENGINE (BUG-PROOF ROUTING)
async function calculateShadowRoute(targetCoords, mode = 'ghost') {
  if (!state.position) throw new Error('Active GPS radar is required. Tap START RADAR first.');

  const start = state.position;
  const end = targetCoords;
  const btn = document.getElementById('btn-calculate-route');

  // Verify Destination Safety
  let destInCone = state.cameras.some(c => getDistanceFeet(end.lat, end.lon, c.lat, c.lon) < 400);
  if (destInCone && mode === 'ghost') {
    alert("CRITICAL: Your exact destination is inside an active surveillance cone. Zero trace is impossible unless you park a block away.");
  }

  // Helper to fetch and score a single route without breaking the loop on API failures
  async function fetchRoute(waypoints) {
    let coordsString = waypoints.map(wp => `${wp.lon},${wp.lat}`).join(';');
    let osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordsString}?overview=full&geometries=geojson`;
    try {
      let res = await fetch(osrmUrl);
      let data = await res.json();
      if (!data.routes || data.routes.length === 0) return null;
      
      let route = data.routes[0];
      let coords = route.geometry.coordinates;
      
      // Calculate camera hits
      let hitCams = new Set();
      coords.forEach(c => {
        state.cameras.forEach(cam => {
          if (getDistanceFeet(c[1], c[0], cam.lat, cam.lon) < 400) hitCams.add(cam.id);
        });
      });
      
      return {
        route: route,
        coords: coords,
        intercepts: hitCams.size,
        distance: route.distance,
        duration: route.duration,
        waypointUsed: waypoints.length === 3 ? waypoints[1] : null
      };
    } catch (e) {
      return null;
    }
  }

  let evaluatedRoutes = [];
  
  // 1. Establish Baseline Direct Route
  let directRoute = await fetchRoute([start, end]);
  if (!directRoute) throw new Error('Engine Error: The routing server cannot find any roads connecting your location to this destination.');
  evaluatedRoutes.push(directRoute);

  // 2. Engage Grid Sweep (Only if Ghost mode and cameras detected)
  if (mode === 'ghost' && directRoute.intercepts > 0) {
    btn.textContent = 'Sweeping Grid for Zero-Trace...';
    
    let mainBearing = getAzimuth(start.lat, start.lon, end.lat, end.lon);
    let totalDistFeet = getDistanceFeet(start.lat, start.lon, end.lat, end.lon);
    
    // We create anchor points at 30%, 50%, and 70% of the way to your destination
    let fractions = [0.3, 0.5, 0.7];
    // For each anchor, we pull the route 1, 2, 3, and 5 miles out to the left and right
    let offsetsFeet = [5280, 10560, 15840, 26400]; 
    
    let foundZero = false;

    // Sweep Loop
    for (let frac of fractions) {
      if (foundZero) break;
      let anchorPoint = getDestinationPoint(start.lat, start.lon, mainBearing, totalDistFeet * frac);
      
      for (let offset of offsetsFeet) {
        if (foundZero) break;

        let leftWP = getDestinationPoint(anchorPoint.lat, anchorPoint.lon, (mainBearing - 90 + 360) % 360, offset);
        let rightWP = getDestinationPoint(anchorPoint.lat, anchorPoint.lon, (mainBearing + 90) % 360, offset);

        // Test Left Evasion
        let leftRoute = await fetchRoute([start, leftWP, end]);
        if (leftRoute) evaluatedRoutes.push(leftRoute);
        if (leftRoute && leftRoute.intercepts === 0) { foundZero = true; break; }

        // Test Right Evasion
        let rightRoute = await fetchRoute([start, rightWP, end]);
        if (rightRoute) evaluatedRoutes.push(rightRoute);
        if (rightRoute && rightRoute.intercepts === 0) { foundZero = true; break; }
      }
    }
  }

  // 3. Final Selection
  if (mode === 'ghost') {
    evaluatedRoutes.sort((a, b) => {
      if (a.intercepts !== b.intercepts) return a.intercepts - b.intercepts;
      return a.duration - b.duration; // Tie-breaker: fastest of the safest
    });
  } else {
    evaluatedRoutes.sort((a, b) => a.duration - b.duration);
  }

  let bestRoute = evaluatedRoutes[0];
  
  // Clean Map
  state.routeLayer.clearLayers();
  state.dodgeLayer.clearLayers();

  // Draw Failed Alternates
  evaluatedRoutes.forEach(r => {
    if (r === bestRoute) return;
    let leafletCoords = r.coords.map(c => [c[1], c[0]]);
    L.polyline(leafletCoords, { color: '#334155', weight: 4, opacity: 0.3, dashArray: '8, 8' }).addTo(state.routeLayer);
  });

  // Draw Winning Route
  let leafletCoords = bestRoute.coords.map(c => [c[1], c[0]]);
  let routeColor = mode === 'ghost' ? '#38bdf8' : '#94a3b8';
  L.polyline(leafletCoords, { color: routeColor, weight: 7, opacity: 0.9 }).addTo(state.routeLayer);
  
  // Place Anchor Dot so you know where it pulled you
  if (bestRoute.waypointUsed) {
     L.circleMarker([bestRoute.waypointUsed.lat, bestRoute.waypointUsed.lon], {
        radius: 6, fillColor: '#10b981', color: '#000', weight: 2, fillOpacity: 1
      }).bindPopup('Evasion Anchor').addTo(state.dodgeLayer);
  }

  state.map.fitBounds(L.polyline(leafletCoords).getBounds(), { padding: [60, 60] });

  // Update UI Stats
  const totalMiles = (bestRoute.distance * METERS_TO_MILES).toFixed(1);
  document.getElementById('route-results').classList.remove('route-results-hidden');
  document.getElementById('res-distance').textContent = `${totalMiles} mi`;
  document.getElementById('res-duration').textContent = `${Math.round(bestRoute.duration / 60)} min`;
  document.getElementById('res-intercepts').textContent = bestRoute.intercepts;

  // Auto-Dismiss Drawer immediately so user can see map
  document.getElementById('panel-routing').classList.add('panel-hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-tab="radar-view"]').classList.add('active');

  // Trigger Result Warning
  setTimeout(() => {
    if (mode === 'ghost') {
      if (bestRoute.intercepts > 0) {
        alert(`Grid saturation warning: Evaluated ${evaluatedRoutes.length} geographic detours. The local grid is heavily boxed in. Best route still forces you through ${bestRoute.intercepts} camera(s).`);
      } else if (bestRoute !== directRoute) {
        alert(`True Zero Trace Achieved. Engine mapped a bypass through a safe Evasion Anchor (green dot).`);
      }
    }
  }, 600);
}

// Ledger & Storage
function logLedgerEntry(camera) {
  const entry = {
    id: `log-${Date.now()}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    hardware: camera.hardware, lat: camera.lat.toFixed(4), lon: camera.lon.toFixed(4)
  };
  state.ledger.unshift(entry);
  if (state.ledger.length > 50) state.ledger.pop();
  localStorage.setItem('ghostlane_ledger', JSON.stringify(state.ledger));
  updateLedgerDisplay();
}

function updateLedgerDisplay() {
  const count = state.ledger.length;
  document.getElementById('ledger-total-count').textContent = count;
  let grade = count > 8 ? 'F' : count > 3 ? 'C' : 'A+';
  let gradeClass = count > 8 ? 'grade-f' : count > 3 ? 'grade-c' : 'grade-a';

  document.getElementById('stat-privacy').textContent = grade;
  document.getElementById('stat-privacy').className = `hud-value ${gradeClass}`;
  if (document.getElementById('ledger-grade')) {
    document.getElementById('ledger-grade').textContent = grade;
    document.getElementById('ledger-grade').className = gradeClass;
  }

  const listEl = document.getElementById('ledger-list');
  if (listEl) {
    if (state.ledger.length === 0) {
      listEl.innerHTML = '<li class="empty-state">No surveillance intercepts recorded today.</li>';
    } else {
      listEl.innerHTML = state.ledger.map(item => `<li class="ledger-item"><div><strong>${item.hardware}</strong><br><small style="color:#94a3b8;">${item.lat}, ${item.lon}</small></div><span>${item.time}</span></li>`).join('');
    }
  }
}

function saveStoredCameras() { localStorage.setItem('ghostlane_nodes', JSON.stringify(state.cameras)); }
function loadStoredCameras() {
  const raw = localStorage.getItem('ghostlane_nodes');
  if (raw) { try { state.cameras = JSON.parse(raw); renderCameraNodes(); } catch (e) { state.cameras = []; } }
}

function toggleLiveRadar() {
  initAudioEngine();
  const btn = document.getElementById('btn-toggle-radar');

  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    btn.textContent = 'START RADAR';
    btn.classList.remove('btn-radar-active');
    return;
  }

  if (!('geolocation' in navigator)) { alert('Geolocation permissions required for live radar.'); return; }

  btn.textContent = 'RADAR LIVE';
  btn.classList.add('btn-radar-active');

  state.watchId = navigator.geolocation.watchPosition(
    pos => {
      const { latitude, longitude, heading, speed } = pos.coords;
      const speedMph = speed ? Math.round(speed * 2.23694) : 0;
      const currentHeading = heading !== null && !isNaN(heading) ? Math.round(heading) : 0;

      state.position = { lat: latitude, lon: longitude, heading: currentHeading, speed: speed || 0 };
      document.getElementById('stat-speed').innerHTML = `${speedMph} <small>MPH</small>`;
      document.getElementById('stat-heading').innerHTML = `${currentHeading}°`;

      if (!state.userMarker) {
        state.userMarker = L.circleMarker([latitude, longitude], { radius: 8, fillColor: '#38bdf8', color: '#ffffff', weight: 2, fillOpacity: 1 }).addTo(state.map);
        state.map.setView([latitude, longitude], 15);
      } else {
        state.userMarker.setLatLng([latitude, longitude]);
      }
      evaluateDirectionalAlerts();
    },
    err => console.warn(`GPS Error: ${err.message}`),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );
}

// UI Event Binding
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  document.getElementById('btn-toggle-radar').addEventListener('click', toggleLiveRadar);
  
  document.getElementById('btn-sync-mesh').addEventListener('click', () => {
    const center = state.position ? state.position : state.map.getCenter();
    syncMeshCameras(center.lat, center.lon || center.lng, 5);
  });
  
  document.getElementById('btn-recenter').addEventListener('click', () => {
    if (state.position) state.map.setView([state.position.lat, state.position.lon], 16);
  });

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.drawer-panel').forEach(p => p.classList.add('panel-hidden'));

      btn.classList.add('active');
      const tab = btn.getAttribute('data-tab');
      if (tab === 'routing-view') document.getElementById('panel-routing').classList.remove('panel-hidden');
      if (tab === 'ledger-view') document.getElementById('panel-ledger').classList.remove('panel-hidden');
      if (tab === 'verify-view') document.getElementById('panel-verify').classList.remove('panel-hidden');
    });
  });

  document.querySelectorAll('.btn-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const panelId = btn.getAttribute('data-close');
      document.getElementById(panelId).classList.add('panel-hidden');
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('[data-tab="radar-view"]').classList.add('active');
    });
  });

  document.getElementById('btn-calculate-route').addEventListener('click', async () => {
    const destInput = document.getElementById('route-dest').value.trim();
    if (!destInput) return alert('Enter a valid destination address or coordinates.');

    const mode = document.querySelector('input[name="route-mode"]:checked').value;
    const btn = document.getElementById('btn-calculate-route');
    
    btn.textContent = 'Threading Zero-Trace Route...';
    btn.style.opacity = '0.7';
    btn.style.pointerEvents = 'none';

    try {
      let targetCoords;
      const parts = destInput.split(',').map(s => parseFloat(s.trim()));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        targetCoords = { lat: parts[0], lon: parts[1] };
      } else {
        targetCoords = await geocodeAddress(destInput);
      }
      
      await calculateShadowRoute(targetCoords, mode);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.textContent = 'Generate Navigation Vectors';
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    }
  });

  document.getElementById('btn-submit-node').addEventListener('click', () => {
    const hardware = document.getElementById('node-hardware').value;
    const heading = parseInt(document.getElementById('node-heading').value, 10);
    const fov = parseInt(document.getElementById('node-fov').value, 10);
    const range = parseInt(document.getElementById('node-range').value, 10) || 400;
    const mode = document.getElementById('node-coords-mode').value;

    let targetLat, targetLon;
    if (mode === 'current' && state.position) { targetLat = state.position.lat; targetLon = state.position.lon; }
    else { const center = state.map.getCenter(); targetLat = center.lat; targetLon = center.lng; }

    state.cameras.push({
      id: `custom-${Date.now()}`, lat: targetLat, lon: targetLon, heading, fov, range, hardware, source: 'Community Verified'
    });

    saveStoredCameras();
    renderCameraNodes();
    document.getElementById('panel-verify').classList.add('panel-hidden');
    document.querySelector('[data-tab="radar-view"]').classList.add('active');
    alert('Node authenticated and written to local mesh!');
  });

  document.getElementById('btn-clear-ledger').addEventListener('click', () => {
    state.ledger = [];
    localStorage.removeItem('ghostlane_ledger');
    updateLedgerDisplay();
  });
});
