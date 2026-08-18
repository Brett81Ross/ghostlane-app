// ==========================================================
// GHOSTLANE CORE ENGINE: HUD FAIL-SAFE & DYNAMIC SIMULATOR
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
  audioCtx: null,
  
  // Active Navigation & Turn-by-Turn State
  activeRouteCoords: null,
  activeDestination: null,
  activeMode: 'ghost',
  lastRecalcTime: 0,
  simInterval: null,
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

// Map Initialization
function initMap() {
  state.map = L.map('map', { center: [35.4676, -97.5164], zoom: 14, zoomControl: false });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OSM &copy; CARTO', maxZoom: 19 }).addTo(state.map);
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
    L.polygon(fovCoords, { color: '#ef4444', weight: 1, fillColor: '#ef4444', fillOpacity: 0.18 }).addTo(state.cameraLayer);
    const icon = L.divIcon({ className: 'cam-marker', html: `<div style="width: 12px; height: 12px; background: #ef4444; border: 2px solid #ffffff; border-radius: 50%; box-shadow: 0 0 8px #ef4444;"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] });
    const marker = L.marker([cam.lat, cam.lon], { icon }).addTo(state.cameraLayer);
    marker.bindPopup(`<div style="color: #0b0f19; font-size: 0.8rem;"><strong>${cam.hardware || 'Camera Node'}</strong><br>Lens Heading: ${cam.heading}°<br>FOV: ${cam.fov || 60}°<br>Range: ${cam.range || 400} ft<br>Source: ${cam.source || 'Verified Node'}</div>`);
  });
  document.getElementById('stat-cams').textContent = state.cameras.length;
}

// Resilient Network Sync
async function syncMeshCameras(lat, lon, radiusMiles = 5) {
  if (!lat || !lon) return alert("Location data is missing. Please wait for map to load or tap START RADAR.");
  const radiusMeters = Math.round(radiusMiles * 1609.34);
  const btn = document.getElementById('btn-sync-mesh');
  btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none';

  const query = `[out:json][timeout:25];(node["man_made"="surveillance"](around:${radiusMeters},${lat},${lon});node["highway"="speed_camera"](around:${radiusMeters},${lat},${lon}););out body;`;
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

    saveStoredCameras(); renderCameraNodes();
    if (newCount > 0) alert(`Mesh Sync Complete. Discovered ${newCount} surveillance nodes.`);
    else alert(`Mesh Sync Complete. No new cameras found.`);
  } catch (err) { alert(`Connection Error: ${err.message}.`); } 
  finally { btn.style.opacity = '1'; btn.style.pointerEvents = 'auto'; }
}

// Geometric Turn Predictor
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

// Radar, Visual Turn HUD & Off-Route Tracking
function evaluateActiveTracking(isSimulation = false) {
  if (!state.position) return;
  const { lat, lon, heading, speed } = state.position;
  const now = Date.now();

  // 1. Camera Intercept Radar
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
    if (closestIntercept) {
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
    } else {
      banner.classList.add('alert-hidden');
      state.activeThreat = null;
    }
  }

  // 2. Active Navigation HUD & Audio Turn-by-Turn
  const turnHud = document.getElementById('turn-hud');
  
  if (state.activeRouteCoords && state.activeRouteCoords.length > 0 && state.activeDestination && turnHud) {
    state.map.setView([lat, lon], 17, { animate: false });

    // Find the next upcoming turn
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

    // Arrival Check 
    let distToDest = getDistanceFeet(lat, lon, state.activeDestination.lat, state.activeDestination.lon);
    if (!upcomingTurn || distToDest < 1000) {
        document.getElementById('turn-direction').textContent = `Destination Ahead`;
        document.getElementById('turn-distance').textContent = `${Math.round(distToDest)} ft`;
        document.getElementById('turn-icon').textContent = '🏁';
        turnHud.classList.remove('turn-hidden');
    }

    if (distToDest < 150) {
      speakVoiceAlert("You have arrived at your zero-trace destination.");
      state.activeRouteCoords = null; state.activeDestination = null;
      state.routeLayer.clearLayers(); state.dodgeLayer.clearLayers();
      turnHud.classList.add('turn-hidden'); 
      if (state.simInterval) clearInterval(state.simInterval);
      return;
    }

    // Off-Route Check
    if (!isSimulation) {
      let minRouteDist = Infinity;
      for (let i = 0; i < state.activeRouteCoords.length - 1; i++) {
        let p1 = state.activeRouteCoords[i]; let p2 = state.activeRouteCoords[i + 1];
        let d = distanceToSegmentFeet(lat, lon, p1[0], p1[1], p2[0], p2[1]);
        if (d < minRouteDist) minRouteDist = d;
      }

      if (minRouteDist > 200) {
        if (now - state.lastRecalcTime > 15000) {
          speakVoiceAlert("Off route. Recalculating evasion vectors.");
          state.lastRecalcTime = now;
          calculateShadowRoute(state.activeDestination, state.activeMode, true);
        }
      }
    }
  } else {
    if(turnHud) turnHud.classList.add('turn-hidden');
  }
}

// LIVE SIMULATOR ENGINE (Dynamic Variable Throttle)
function runLiveSimulation() {
  if (!state.activeRouteCoords || state.activeRouteCoords.length === 0) return alert("You must generate a Shadow Route first before running the simulator.");
  initAudioEngine();
  
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId); state.watchId = null;
    document.getElementById('btn-toggle-radar').textContent = 'START RADAR';
    document.getElementById('btn-toggle-radar').classList.remove('btn-radar-active');
  }

  if (state.simInterval) clearInterval(state.simInterval);
  speakVoiceAlert("Navigation simulation initiated. Engaging dynamic fast forward.");
  
  document.getElementById('panel-routing').classList.add('panel-hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-tab="radar-view"]').classList.add('active');

  let coords = state.activeRouteCoords;
  let currentSegIdx = 0;
  let distTraveledOnSeg = 0;
  let tickRateMs = 100;

  state.simInterval = setInterval(() => {
    if (currentSegIdx >= coords.length - 1) { clearInterval(state.simInterval); return; }

    let p1 = coords[currentSegIdx]; 
    let p2 = coords[currentSegIdx + 1];

    let upcomingTurn = (state.turnWaypoints || []).find(t => !t.passed);
    let targetLat = upcomingTurn ? upcomingTurn.lat : state.activeDestination.lat;
    let targetLon = upcomingTurn ? upcomingTurn.lon : state.activeDestination.lon;
    
    let distToTarget = getDistanceFeet(p1[0], p1[1], targetLat, targetLon);
    
    let speedFps = 66; 
    let displayMph = 45;

    if (distToTarget > 2500) {
       speedFps = 586; // 400 MPH
       displayMph = 400;
    } else if (distToTarget > 1200) {
       speedFps = 220; // 150 MPH
       displayMph = 150;
    } else if (distToTarget > 600) {
       speedFps = 102; // 70 MPH
       displayMph = 70;
    } else {
       speedFps = 51;  // 35 MPH
       displayMph = 35;
    }

    let distPerTick = speedFps * (tickRateMs / 1000);
    let segDist = getDistanceFeet(p1[0], p1[1], p2[0], p2[1]);
    distTraveledOnSeg += distPerTick;

    while (distTraveledOnSeg >= segDist) {
      distTraveledOnSeg -= segDist;
      currentSegIdx++;
      if (currentSegIdx >= coords.length - 1) { clearInterval(state.simInterval); return; }
      p1 = coords[currentSegIdx]; p2 = coords[currentSegIdx + 1];
      segDist = getDistanceFeet(p1[0], p1[1], p2[0], p2[1]);
    }

    let ratio = segDist === 0 ? 0 : distTraveledOnSeg / segDist;
    let currentLat = p1[0] + (p2[0] - p1[0]) * ratio;
    let currentLon = p1[1] + (p2[1] - p1[1]) * ratio;
    let currentHeading = getAzimuth(p1[0], p1[1], p2[0], p2[1]);

    state.position = { lat: currentLat, lon: currentLon, heading: currentHeading, speed: displayMph * 0.44704 };
    
    document.getElementById('stat-speed').innerHTML = `${displayMph} <small>SIM</small>`;
    document.getElementById('stat-heading').innerHTML = `${Math.round(currentHeading)}°`;

    if (!state.userMarker) {
        state.userMarker = L.circleMarker([currentLat, currentLon], { radius: 8, fillColor: '#38bdf8', color: '#ffffff', weight: 2, fillOpacity: 1 }).addTo(state.map);
    } else { 
        state.userMarker.setLatLng([currentLat, currentLon]); 
    }

    evaluateActiveTracking(true);
  }, tickRateMs); 
}

// EXCLUSION-ZONE ROUTING ENGINE
async function calculateShadowRoute(targetCoords, mode = 'ghost', isAutoRecalc = false) {
  if (!state.position) throw new Error('Active GPS radar is required. Tap START RADAR first.');
  const start = state.position; const end = targetCoords; const btn = document.getElementById('btn-calculate-route');

  if (!isAutoRecalc) {
    let destInCone = state.cameras.some(c => getDistanceFeet(end.lat, end.lon, c.lat, c.lon) < 400);
    if (destInCone && mode === 'ghost') alert("CRITICAL: Your destination is inside an active surveillance cone. Zero trace is impossible unless you park a block away.");
    btn.textContent = 'Threading Zero-Trace Route...'; btn.style.opacity = '0.7'; btn.style.pointerEvents = 'none';
  }

  try {
    let routeGeoJson = null; let finalIntercepts = 0;

    if (mode === 'ghost') {
      const routeMidLat = (start.lat + end.lat) / 2; const routeMidLon = (start.lon + end.lon) / 2;
      const maxDist = getDistanceFeet(start.lat, start.lon, end.lat, end.lon) + 26400;

      const relevantCameras = state.cameras.filter(cam => getDistanceFeet(routeMidLat, routeMidLon, cam.lat, cam.lon) < maxDist);
      const nogos = relevantCameras.map(c => `${c.lon.toFixed(5)},${c.lat.toFixed(5)},150`).join('|');
      
      const brouterUrl = `https://brouter.de/brouter?lonlats=${start.lon},${start.lat}|${end.lon},${end.lat}&nogos=${nogos}&profile=car-eco&format=geojson`;
      const res = await fetch(brouterUrl);
      if (!res.ok) throw new Error("The zero-trace engine could not find a path around this many cameras. They form a blockade.");
      const data = await res.json();
      if (!data.features || data.features.length === 0) throw new Error("No safe route exists.");
      
      routeGeoJson = data.features[0];

      let hitCams = new Set();
      routeGeoJson.geometry.coordinates.forEach(c => { state.cameras.forEach(cam => { if (getDistanceFeet(c[1], c[0], cam.lat, cam.lon) < 300) hitCams.add(cam.id); }); });
      finalIntercepts = hitCams.size;

    } else {
      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${start.lon},${start.lat};${end.lon},${end.lat}?overview=full&geometries=geojson`;
      const res = await fetch(osrmUrl);
      const data = await res.json();
      if (!data.routes || data.routes.length === 0) throw new Error("No route found.");
      
      routeGeoJson = { geometry: data.routes[0].geometry, properties: { "track-length": data.routes[0].distance, "total-time": data.routes[0].duration } };
      let hitCams = new Set();
      routeGeoJson.geometry.coordinates.forEach(c => { state.cameras.forEach(cam => { if (getDistanceFeet(c[1], c[0], cam.lat, cam.lon) < 300) hitCams.add(cam.id); }); });
      finalIntercepts = hitCams.size;
    }

    state.routeLayer.clearLayers(); state.dodgeLayer.clearLayers();
    const leafletCoords = routeGeoJson.geometry.coordinates.map(c => [c[1], c[0]]);
    const routeColor = mode === 'ghost' ? '#38bdf8' : '#94a3b8';
    
    L.polyline(leafletCoords, { color: routeColor, weight: 7, opacity: 0.9 }).addTo(state.routeLayer);
    if (!isAutoRecalc) state.map.fitBounds(L.polyline(leafletCoords).getBounds(), { padding: [60, 60] });

    buildTurnInstructions(leafletCoords);

    const distanceMeters = routeGeoJson.properties["track-length"] || routeGeoJson.properties.distance || 0;
    const durationSeconds = routeGeoJson.properties["total-time"] || routeGeoJson.properties.duration || 0;
    const totalMiles = (distanceMeters * METERS_TO_MILES).toFixed(1);
    
    document.getElementById('route-results').classList.remove('route-results-hidden');
    document.getElementById('res-distance').textContent = `${totalMiles} mi`;
    document.getElementById('res-duration').textContent = `${Math.round(durationSeconds / 60)} min`;
    document.getElementById('res-intercepts').textContent = finalIntercepts;

    state.activeRouteCoords = leafletCoords; state.activeDestination = targetCoords; state.activeMode = mode;
    
    evaluateActiveTracking(isAutoRecalc);

  } catch (err) { if (!isAutoRecalc) alert(err.message); } 
  finally {
    if (!isAutoRecalc) { btn.textContent = 'Generate Navigation Vectors'; btn.style.opacity = '1'; btn.style.pointerEvents = 'auto'; }
  }
}

// Ledger & Storage
function logLedgerEntry(camera) {
  const entry = { id: `log-${Date.now()}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), hardware: camera.hardware, lat: camera.lat.toFixed(4), lon: camera.lon.toFixed(4) };
  state.ledger.unshift(entry); if (state.ledger.length > 50) state.ledger.pop();
  localStorage.setItem('ghostlane_ledger', JSON.stringify(state.ledger)); updateLedgerDisplay();
}

function updateLedgerDisplay() {
  const count = state.ledger.length; document.getElementById('ledger-total-count').textContent = count;
  let grade = count > 8 ? 'F' : count > 3 ? 'C' : 'A+'; let gradeClass = count > 8 ? 'grade-f' : count > 3 ? 'grade-c' : 'grade-a';
  document.getElementById('stat-privacy').textContent = grade; document.getElementById('stat-privacy').className = `hud-value ${gradeClass}`;
  if (document.getElementById('ledger-grade')) { document.getElementById('ledger-grade').textContent = grade; document.getElementById('ledger-grade').className = gradeClass; }
  const listEl = document.getElementById('ledger-list');
  if (listEl) {
    if (state.ledger.length === 0) listEl.innerHTML = '<li class="empty-state">No surveillance intercepts recorded today.</li>';
    else listEl.innerHTML = state.ledger.map(item => `<li class="ledger-item"><div><strong>${item.hardware}</strong><br><small style="color:#94a3b8;">${item.lat}, ${item.lon}</small></div><span>${item.time}</span></li>`).join('');
  }
}

function saveStoredCameras() { localStorage.setItem('ghostlane_nodes', JSON.stringify(state.cameras)); }
function loadStoredCameras() { const raw = localStorage.getItem('ghostlane_nodes'); if (raw) { try { state.cameras = JSON.parse(raw); renderCameraNodes(); } catch (e) { state.cameras = []; } } }

function toggleLiveRadar() {
  initAudioEngine(); const btn = document.getElementById('btn-toggle-radar');
  const turnHud = document.getElementById('turn-hud');
  
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId); state.watchId = null;
    btn.textContent = 'START RADAR'; btn.classList.remove('btn-radar-active');
    state.activeRouteCoords = null; state.activeDestination = null;
    state.routeLayer.clearLayers(); if (state.simInterval) clearInterval(state.simInterval);
    if(turnHud) turnHud.classList.add('turn-hidden');
    return;
  }
  if (!('geolocation' in navigator)) return alert('Geolocation permissions required for live radar.');
  btn.textContent = 'RADAR LIVE'; btn.classList.add('btn-radar-active');

  state.watchId = navigator.geolocation.watchPosition(
    pos => {
      const { latitude, longitude, heading, speed } = pos.coords;
      const speedMph = speed ? Math.round(speed * 2.23694) : 0;
      const currentHeading = heading !== null && !isNaN(heading) ? Math.round(heading) : 0;
      state.position = { lat: latitude, lon: longitude, heading: currentHeading, speed: speed || 0 };
      document.getElementById('stat-speed').innerHTML = `${speedMph} <small>MPH</small>`;
      document.getElementById('stat-heading').innerHTML = `${currentHeading}°`;

      if (!state.userMarker) { state.userMarker = L.circleMarker([latitude, longitude], { radius: 8, fillColor: '#38bdf8', color: '#ffffff', weight: 2, fillOpacity: 1 }).addTo(state.map); if (!state.activeRouteCoords) state.map.setView([latitude, longitude], 15); } 
      else { state.userMarker.setLatLng([latitude, longitude]); }
      evaluateActiveTracking();
    },
    err => console.warn(`GPS Error: ${err.message}`), { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );
}

// UI Event Binding
document.addEventListener('DOMContentLoaded', () => {
  initMap(); document.getElementById('btn-toggle-radar').addEventListener('click', toggleLiveRadar);
  document.getElementById('btn-sync-mesh').addEventListener('click', () => { const center = state.position ? state.position : state.map.getCenter(); syncMeshCameras(center.lat, center.lon || center.lng, 5); });
  document.getElementById('btn-recenter').addEventListener('click', () => { if (state.position) state.map.setView([state.position.lat, state.position.lon], 16); });

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
      const panelId = btn.getAttribute('data-close'); document.getElementById(panelId).classList.add('panel-hidden');
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('[data-tab="radar-view"]').classList.add('active');
    });
  });

  document.getElementById('btn-calculate-route').addEventListener('click', async () => {
    const destInput = document.getElementById('route-dest').value.trim();
    if (!destInput) return alert('Enter a valid destination address or coordinates.');
    const mode = document.querySelector('input[name="route-mode"]:checked').value;
    try {
      let targetCoords; const parts = destInput.split(',').map(s => parseFloat(s.trim()));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) { targetCoords = { lat: parts[0], lon: parts[1] }; } 
      else { targetCoords = await geocodeAddress(destInput); }
      await calculateShadowRoute(targetCoords, mode, false);
    } catch (err) { alert(err.message); }
  });

  document.getElementById('btn-simulate-route').addEventListener('click', runLiveSimulation);

  document.getElementById('btn-submit-node').addEventListener('click', () => {
    const hardware = document.getElementById('node-hardware').value; const heading = parseInt(document.getElementById('node-heading').value, 10);
    const fov = parseInt(document.getElementById('node-fov').value, 10); const range = parseInt(document.getElementById('node-range').value, 10) || 400;
    const mode = document.getElementById('node-coords-mode').value; let targetLat, targetLon;
    if (mode === 'current' && state.position) { targetLat = state.position.lat; targetLon = state.position.lon; } else { const center = state.map.getCenter(); targetLat = center.lat; targetLon = center.lng; }
    state.cameras.push({ id: `custom-${Date.now()}`, lat: targetLat, lon: targetLon, heading, fov, range, hardware, source: 'Community Verified' });
    saveStoredCameras(); renderCameraNodes();
    document.getElementById('panel-verify').classList.add('panel-hidden'); document.querySelector('[data-tab="radar-view"]').classList.add('active');
    alert('Node authenticated and written to local mesh!');
  });

  document.getElementById('btn-clear-ledger').addEventListener('click', () => { state.ledger = []; localStorage.removeItem('ghostlane_ledger'); updateLedgerDisplay(); });
});
