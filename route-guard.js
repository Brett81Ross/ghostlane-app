(() => {
  'use strict';

  const VERSION = '1.8.0';
  const REQUEST_TIMEOUT_MS = 7500;
  const MESH_WAIT_MS = 26000;
  const FLOCK_BUFFER_METERS = 160;
  const BLOCKING_CAMERA_BUFFER_METERS = 120;
  const DETOUR_RADII_METERS = [1400, 3800, 7600, 12000];
  const DETOUR_BEARINGS = [0, 60, 120, 180, 240, 300];
  const COVERAGE = {
    minLat: 35.15,
    minLng: -97.95,
    maxLat: 35.85,
    maxLng: -97.05
  };

  let activeStrictRoute = null;
  let integrityAlertOpen = false;

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function cameraText(camera) {
    const sources = Array.isArray(camera?.sources) ? camera.sources.join(' ') : '';
    return [
      camera?.category,
      camera?.id,
      camera?.node_id,
      camera?.label,
      camera?.type,
      camera?.hardware,
      camera?.source,
      sources
    ].filter(Boolean).join(' ');
  }

  function isFlockCamera(camera) {
    return camera?.category === 'alpr' ||
      /flock|alpr|automatic\s+license|license\s*plate|plate\s*reader|\blpr\b/i.test(cameraText(camera));
  }

  function isRouteBlockingCamera(camera) {
    if (isFlockCamera(camera)) return true;
    if (camera?.routeBlocking !== true) return false;
    return !['red-light', 'speed', 'traffic'].includes(camera?.category);
  }

  function cameraBuffer(camera) {
    return isFlockCamera(camera) ? FLOCK_BUFFER_METERS : BLOCKING_CAMERA_BUFFER_METERS;
  }

  function cameraKey(camera) {
    return String(
      camera?.node_id ||
      camera?.id ||
      `${Number(camera?.lat).toFixed(6)},${Number(camera?.lng).toFixed(6)}`
    );
  }

  function clearRoute() {
    activeStrictRoute = null;
    document.getElementById('gl-route-choices')?.remove();
    if (routePolyline) {
      try {
        map.removeLayer(routePolyline);
      } catch (_) {}
      routePolyline = null;
    }
    routeSteps = [];
    currentStepIdx = 0;
    const hud = document.getElementById('turn-hud');
    if (hud) hud.style.display = 'none';
  }

  async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestRoutes(points, alternatives = true) {
    const coordinates = points.map(point => `${point[1]},${point[0]}`).join(';');
    const data = await getJson(
      `https://router.project-osrm.org/route/v1/driving/${coordinates}` +
      `?overview=full&geometries=geojson&steps=true&alternatives=${alternatives ? 'true' : 'false'}` +
      '&continue_straight=false'
    );
    return data.routes || [];
  }

  function pointToSegmentMeters(lat, lng, a, b) {
    const metersPerLngDegree = 111320 * Math.cos(lat * Math.PI / 180);
    const metersPerLatDegree = 110540;
    const ax = (a[0] - lng) * metersPerLngDegree;
    const ay = (a[1] - lat) * metersPerLatDegree;
    const bx = (b[0] - lng) * metersPerLngDegree;
    const by = (b[1] - lat) * metersPerLatDegree;
    const vx = bx - ax;
    const vy = by - ay;
    const lengthSquared = vx * vx + vy * vy;
    const t = Math.max(0, Math.min(1, lengthSquared ? -(ax * vx + ay * vy) / lengthSquared : 0));
    return Math.hypot(ax + t * vx, ay + t * vy);
  }

  function insideCoverage(point) {
    return point[0] >= COVERAGE.minLat &&
      point[0] <= COVERAGE.maxLat &&
      point[1] >= COVERAGE.minLng &&
      point[1] <= COVERAGE.maxLng;
  }

  function auditRoute(route) {
    const points = route?.geometry?.coordinates || [];
    if (points.length < 2) {
      return { hits: [], count: 0, clear: false, coverageClear: false, invalid: true };
    }

    const coverageClear = points.every(point => insideCoverage([point[1], point[0]]));
    const minLat = Math.min(...points.map(point => point[1]));
    const maxLat = Math.max(...points.map(point => point[1]));
    const minLng = Math.min(...points.map(point => point[0]));
    const maxLng = Math.max(...points.map(point => point[0]));
    const hits = [];
    const seen = new Set();

    for (const camera of cameraLocations || []) {
      if (!isRouteBlockingCamera(camera)) continue;

      const lat = Number(camera.lat);
      const lng = Number(camera.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const buffer = cameraBuffer(camera);
      const latitudeMargin = buffer / 110540;
      const longitudeMargin = buffer / Math.max(1, 111320 * Math.cos(lat * Math.PI / 180));
      if (
        lat < minLat - latitudeMargin ||
        lat > maxLat + latitudeMargin ||
        lng < minLng - longitudeMargin ||
        lng > maxLng + longitudeMargin
      ) continue;

      let bestDistance = Infinity;
      let segmentIndex = -1;
      for (let index = 0; index < points.length - 1; index++) {
        const a = points[index];
        const b = points[index + 1];
        if (
          lat < Math.min(a[1], b[1]) - latitudeMargin ||
          lat > Math.max(a[1], b[1]) + latitudeMargin ||
          lng < Math.min(a[0], b[0]) - longitudeMargin ||
          lng > Math.max(a[0], b[0]) + longitudeMargin
        ) continue;

        const distance = pointToSegmentMeters(lat, lng, a, b);
        if (distance < bestDistance) {
          bestDistance = distance;
          segmentIndex = index;
        }
        if (bestDistance <= buffer) break;
      }

      if (bestDistance <= buffer) {
        const key = cameraKey(camera);
        if (!seen.has(key)) {
          seen.add(key);
          hits.push({ camera, distance: bestDistance, segmentIndex, buffer });
        }
      }
    }

    hits.sort((a, b) => a.segmentIndex - b.segmentIndex || a.distance - b.distance);
    return {
      hits,
      count: hits.length,
      clear: coverageClear && hits.length === 0,
      coverageClear,
      invalid: false
    };
  }

  function destinationPoint(lat, lng, bearing, distanceMeters) {
    const earthRadius = 6371000;
    const bearingRadians = bearing * Math.PI / 180;
    const latitude = lat * Math.PI / 180;
    const longitude = lng * Math.PI / 180;
    const angularDistance = distanceMeters / earthRadius;
    const destinationLatitude = Math.asin(
      Math.sin(latitude) * Math.cos(angularDistance) +
      Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearingRadians)
    );
    const destinationLongitude = longitude + Math.atan2(
      Math.sin(bearingRadians) * Math.sin(angularDistance) * Math.cos(latitude),
      Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(destinationLatitude)
    );
    return [
      destinationLatitude * 180 / Math.PI,
      ((destinationLongitude * 180 / Math.PI + 540) % 360) - 180
    ];
  }

  function uniqueCandidates(candidates) {
    const seen = new Set();
    return candidates.filter(candidate => {
      const points = candidate.route?.geometry?.coordinates || [];
      const midpoint = points[Math.floor(points.length / 2)] || [0, 0];
      const key = [
        Math.round(candidate.route.distance / 20),
        Math.round(candidate.route.duration / 10),
        candidate.audit.count,
        midpoint[0].toFixed(4),
        midpoint[1].toFixed(4)
      ].join('-');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function addCandidates(output, points) {
    try {
      const routes = await requestRoutes(points, true);
      for (const route of routes) output.push({ route, audit: auditRoute(route) });
    } catch (error) {
      console.warn('[GhostLane] route candidate rejected:', error.message || error);
    }
  }

  function clearCandidateCount(candidates) {
    return uniqueCandidates(candidates).filter(candidate => candidate.audit.clear).length;
  }

  async function collectCandidates(start, end) {
    const output = [];
    await addCandidates(output, [start, end]);

    const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    for (const radius of DETOUR_RADII_METERS) {
      const waypoints = DETOUR_BEARINGS
        .map(bearing => destinationPoint(midpoint[0], midpoint[1], bearing, radius))
        .filter(insideCoverage);
      await Promise.all(waypoints.map(waypoint => addCandidates(output, [start, waypoint, end])));
      if (clearCandidateCount(output) >= 3) return uniqueCandidates(output);
    }

    const blockerMap = new Map();
    const bestExposed = uniqueCandidates(output)
      .filter(candidate => candidate.audit.hits.length)
      .sort((a, b) => a.audit.count - b.audit.count || a.route.duration - b.route.duration)
      .slice(0, 3);

    for (const candidate of bestExposed) {
      for (const hit of candidate.audit.hits.slice(0, 3)) {
        blockerMap.set(cameraKey(hit.camera), hit.camera);
      }
    }

    const blockers = [...blockerMap.values()].slice(0, 2);
    for (const blocker of blockers) {
      const bypassDistance = Math.max(900, cameraBuffer(blocker) * 7);
      const waypoints = DETOUR_BEARINGS
        .map(bearing => destinationPoint(Number(blocker.lat), Number(blocker.lng), bearing, bypassDistance))
        .filter(insideCoverage);
      await Promise.all(waypoints.map(waypoint => addCandidates(output, [start, waypoint, end])));
      if (clearCandidateCount(output) >= 3) break;
    }

    if (blockers.length === 2 && clearCandidateCount(output) < 3) {
      const pairedDetours = DETOUR_BEARINGS.map(bearing => [
        destinationPoint(Number(blockers[0].lat), Number(blockers[0].lng), bearing, 1100),
        destinationPoint(Number(blockers[1].lat), Number(blockers[1].lng), bearing, 1100)
      ]).filter(pair => pair.every(insideCoverage));
      await Promise.all(pairedDetours.map(pair => addCandidates(output, [start, ...pair, end])));
    }

    return uniqueCandidates(output);
  }

  function routeChoices(clearCandidates) {
    const options = [];
    const used = new Set();
    const add = (name, candidate) => {
      if (!candidate) return;
      const key = `${Math.round(candidate.route.distance)}-${Math.round(candidate.route.duration)}`;
      if (used.has(key)) return;
      used.add(key);
      options.push({ name, item: candidate });
    };

    add('ZERO-FLOCK FASTEST', [...clearCandidates].sort((a, b) => a.route.duration - b.route.duration)[0]);
    add('ZERO-FLOCK SHORTEST', [...clearCandidates].sort((a, b) => a.route.distance - b.route.distance)[0]);
    add('ZERO-FLOCK ALTERNATE', [...clearCandidates].sort((a, b) =>
      (a.route.duration + a.route.distance / 14) - (b.route.duration + b.route.distance / 14)
    )[1]);

    return options.slice(0, 3);
  }

  function strictMeshStatus() {
    const status = window.GhostLanePublicMeshStatus;
    if (!status) {
      return { ok: false, reason: 'The current Flock camera mesh has not finished syncing.' };
    }
    if (status.partial || (status.failures || []).length) {
      return {
        ok: false,
        reason: 'One or more camera sources is unavailable, so GhostLane cannot verify a zero-Flock route.'
      };
    }

    const sourceNames = (status.sources || []).map(source =>
      String(typeof source === 'string' ? source : source?.name || '')
    ).join(' ');
    if (!/deflock/i.test(sourceNames) || !/openstreetmap|overpass/i.test(sourceNames)) {
      return {
        ok: false,
        reason: 'Both DeFlock and OpenStreetMap camera sources are required before strict routing can begin.'
      };
    }
    if (!Number.isFinite(Number(status.total)) || Number(status.total) < 1) {
      return { ok: false, reason: 'No verified camera records are loaded for this routing session.' };
    }
    return { ok: true };
  }

  async function waitForTrustedMesh() {
    const deadline = Date.now() + MESH_WAIT_MS;
    while (Date.now() < deadline) {
      const status = strictMeshStatus();
      if (status.ok) return;
      if (window.GhostLanePublicMeshStatus) throw new Error(status.reason);
      await delay(350);
    }
    throw new Error(strictMeshStatus().reason);
  }

  function drawRoute(candidate) {
    clearRoute();
    const route = candidate.route;
    const latLngs = route.geometry.coordinates.map(point => [point[1], point[0]]);
    routePolyline = L.polyline(latLngs, {
      color: '#22c55e',
      weight: 6,
      dashArray: '8, 8'
    }).addTo(map);
    map.fitBounds(routePolyline.getBounds(), { padding: [60, 60] });
    routeSteps = (route.legs || []).flatMap(leg => leg.steps || []);
    currentStepIdx = 0;
    activeStrictRoute = route;

    if (routeSteps.length) {
      const hud = document.getElementById('turn-hud');
      if (hud) hud.style.display = 'flex';
      updateTurnHUD(routeSteps[0]);
    }

    if (typeof speakAlert === 'function') {
      speakAlert('Zero known Flock exposure route acquired.');
    }
  }

  async function rejectRoute(title, message) {
    if (typeof showHudModal === 'function') {
      await showHudModal(title, message, { tone: 'danger' });
    } else {
      alert(`${title}\n\n${message}`);
    }
  }

  function showChoices(options, clearCount, rejectedCount) {
    document.getElementById('gl-route-choices')?.remove();
    const box = document.createElement('div');
    box.id = 'gl-route-choices';
    box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:78px;z-index:9998;background:rgba(5,12,22,.98);border:1px solid #166534;border-radius:16px;padding:10px;box-shadow:0 14px 35px #000a;font-family:system-ui;color:#fff';
    box.innerHTML = `
      <div style="font-weight:900;font-size:12px;letter-spacing:.8px;color:#86efac;margin:2px 4px 4px">ZERO-FLOCK ROUTES ONLY</div>
      <div style="font-size:9px;line-height:1.35;color:#94a3b8;margin:0 4px 8px">
        ${clearCount} route${clearCount === 1 ? '' : 's'} passed the current mapped-camera audit. ${rejectedCount} exposed route${rejectedCount === 1 ? '' : 's'} rejected.
      </div>`;

    options.forEach(option => {
      const candidate = option.item;
      const button = document.createElement('button');
      const minutes = Math.round(candidate.route.duration / 60);
      const miles = (candidate.route.distance / 1609.344).toFixed(1);
      button.style.cssText = 'width:100%;display:flex;justify-content:space-between;align-items:center;margin:6px 0;padding:12px;border-radius:12px;border:1px solid #166534;background:#0b1f18;color:#fff;text-align:left';
      button.innerHTML = `
        <span><b>${option.name}</b><br><small>${miles} mi • ~${minutes} min</small></span>
        <span style="font-weight:900;color:#4ade80">0 KNOWN FLOCK</span>`;
      button.onclick = async () => {
        const mesh = strictMeshStatus();
        const finalAudit = auditRoute(candidate.route);
        if (!mesh.ok || !finalAudit.clear) {
          box.remove();
          await rejectRoute(
            'Route Integrity Lost',
            mesh.ok
              ? 'The camera mesh changed and this route now enters a known Flock/ALPR safety zone. Navigation was not started.'
              : `${mesh.reason} Navigation was not started.`
          );
          return;
        }

        drawRoute(candidate);
        box.remove();
        if (typeof showHudToast === 'function') {
          showHudToast(`${option.name} • 0 known Flock exposures`);
        }
      };
      box.appendChild(button);
    });

    const note = document.createElement('div');
    note.style.cssText = 'font-size:8px;color:#64748b;line-height:1.35;margin:7px 4px 1px';
    note.textContent = 'Strict routing uses currently mapped cameras. New, moved, private, or unreported cameras may not be in the mesh.';
    box.appendChild(note);
    document.body.appendChild(box);
  }

  function remainingRoute(route) {
    const points = route?.geometry?.coordinates || [];
    if (!Array.isArray(userCoords) || points.length < 3) return route;
    let closestIndex = 0;
    let closestDistance = Infinity;
    for (let index = 0; index < points.length; index++) {
      const distance = map.distance(userCoords, [points[index][1], points[index][0]]);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    }
    return {
      ...route,
      geometry: {
        ...route.geometry,
        coordinates: points.slice(Math.max(0, closestIndex - 1))
      }
    };
  }

  async function monitorRouteIntegrity() {
    if (!activeStrictRoute || integrityAlertOpen) return;
    const mesh = strictMeshStatus();
    const audit = auditRoute(remainingRoute(activeStrictRoute));
    if (mesh.ok && audit.clear) return;

    integrityAlertOpen = true;
    clearRoute();
    if (typeof speakAlert === 'function') {
      speakAlert('Flock exposure detected. Navigation stopped.');
    }
    await rejectRoute(
      'Navigation Stopped',
      mesh.ok
        ? 'A new mapped Flock/ALPR exposure now intersects the remaining route. GhostLane stopped navigation instead of continuing through it.'
        : `${mesh.reason} GhostLane stopped navigation because route integrity can no longer be verified.`
    );
    integrityAlertOpen = false;
  }

  async function search() {
    const query = document.getElementById('dest-address')?.value?.trim();
    if (!query) return;

    closeSearch();
    clearRoute();
    try {
      if (typeof showHudToast === 'function') {
        showHudToast('Verifying camera mesh and zero-Flock alternatives…');
      }

      await waitForTrustedMesh();
      if (typeof hasLiveGpsFix !== 'undefined' && !hasLiveGpsFix) {
        throw new Error('A current high-accuracy GPS fix is required before strict routing can begin.');
      }
      if (!Array.isArray(userCoords)) {
        throw new Error('Current GPS location is not ready yet.');
      }

      const start = [Number(userCoords[0]), Number(userCoords[1])];
      if (!insideCoverage(start)) {
        throw new Error('Your current location is outside the verified Oklahoma City camera-mesh coverage area.');
      }

      const geocoded = await getJson(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`
      );
      if (!geocoded.length) throw new Error('Destination not found.');

      const end = [Number(geocoded[0].lat), Number(geocoded[0].lon)];
      if (!insideCoverage(end)) {
        throw new Error('That destination is outside the verified Oklahoma City camera-mesh coverage area.');
      }

      const candidates = await collectCandidates(start, end);
      if (!candidates.length) {
        throw new Error('The routing service did not return any auditable route candidates.');
      }

      const clearCandidates = candidates.filter(candidate => candidate.audit.clear);
      if (!clearCandidates.length) {
        const exposed = candidates.filter(candidate => candidate.audit.hits.length);
        const minimumHits = exposed.length
          ? Math.min(...exposed.map(candidate => candidate.audit.count))
          : 0;
        const detail = minimumHits
          ? `The least-exposed option still crossed ${minimumHits} known Flock/ALPR safety zone${minimumHits === 1 ? '' : 's'}.`
          : 'Every returned option left the verified camera-mesh coverage area.';
        const error = new Error(
          `GhostLane rejected all ${candidates.length} route candidates. ${detail} Navigation was not started.`
        );
        error.title = 'No Zero-Flock Route Found';
        throw error;
      }

      const rejectedCount = candidates.length - clearCandidates.length;
      showChoices(routeChoices(clearCandidates), clearCandidates.length, rejectedCount);
      if (typeof showHudToast === 'function') {
        showHudToast(`${clearCandidates.length} zero-Flock route${clearCandidates.length === 1 ? '' : 's'} verified`);
      }
    } catch (error) {
      await rejectRoute(
        error.title || 'Strict Route Unavailable',
        error.message || 'Unable to calculate a verified zero-Flock route. Navigation was not started.'
      );
    }
  }

  window.GhostLaneRouteGuard = {
    version: VERSION,
    auditRoute,
    strictMeshStatus
  };
  const footer = document.querySelector('.app-footer');
  if (footer) {
    footer.textContent = `GhostLane™ • v${VERSION} • Cactus🌵Byte Studios™ • All Rights Reserved`;
  }
  window.executeSearch = search;
  setInterval(monitorRouteIntegrity, 4000);
})();
