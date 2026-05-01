const RADAR_SERVICE =
  "https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer/exportImage";

const TILE_SIZE = 256;
const EARTH_RADIUS = 6378137;
const NORMAL_IL = { lat: 40.5142, lon: -88.9906 };
const state = {
  center: { ...NORMAL_IL },
  zoom: 8,
  opacity: 0.86,
  radarImage: null,
  lastGoodFrame: null,
  playTimer: null,
  frameIndex: 0,
  requestId: 0,
  loadStarted: 0,
  pointers: new Map(),
  pinchStart: null,
};

const $ = (id) => document.getElementById(id);
const mapEl = $("map");
const basemap = $("basemap");
const ctx = basemap.getContext("2d");
const radarEl = $("radar");

const PLACES = [
  { name: "Normal", lat: 40.5142, lon: -88.9906 },
  { name: "Bloomington", lat: 40.4842, lon: -88.9937 },
  { name: "Peoria", lat: 40.6936, lon: -89.589 },
  { name: "Springfield", lat: 39.7817, lon: -89.6501 },
  { name: "Champaign", lat: 40.1164, lon: -88.2434 },
  { name: "Decatur", lat: 39.8403, lon: -88.9548 },
  { name: "Pontiac", lat: 40.8809, lon: -88.6298 },
  { name: "Lincoln", lat: 40.1484, lon: -89.3648 },
  { name: "Joliet", lat: 41.525, lon: -88.0817 },
  { name: "Chicago", lat: 41.8781, lon: -87.6298 },
  { name: "St. Louis", lat: 38.627, lon: -90.1994 },
  { name: "Indianapolis", lat: 39.7684, lon: -86.1581 },
];

const ROADS = [
  { name: "I-55", color: "#d96b75", width: 2.3, points: [[41.88, -87.63], [41.52, -88.08], [40.88, -88.63], [40.51, -88.99], [40.15, -89.36], [39.78, -89.65], [38.63, -90.2]] },
  { name: "I-74", color: "#d96b75", width: 2.3, points: [[40.69, -89.59], [40.51, -88.99], [40.12, -88.24], [39.77, -86.16]] },
  { name: "I-39", color: "#d96b75", width: 2.1, points: [[42.27, -89.09], [41.89, -89.07], [41.36, -89.13], [40.88, -88.99], [40.51, -88.99]] },
  { name: "US-51", color: "#e0a84f", width: 1.7, points: [[41.0, -89.02], [40.51, -88.99], [40.15, -89.36], [39.84, -88.95], [39.48, -89.0]] },
  { name: "US-150", color: "#e0a84f", width: 1.7, points: [[40.73, -89.62], [40.51, -88.99], [40.31, -88.65], [40.12, -88.24]] },
];

function setStatus(text, tone = "") {
  const status = $("status");
  status.textContent = text;
  status.className = `status ${tone}`.trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

function lonToX(lon, zoom) {
  return ((lon + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

function latToY(lat, zoom) {
  const sin = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * TILE_SIZE * 2 ** zoom;
}

function xToLon(x, zoom) {
  return (x / (TILE_SIZE * 2 ** zoom)) * 360 - 180;
}

function yToLat(y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / (TILE_SIZE * 2 ** zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function mercatorMeters(lat, lon) {
  return {
    x: (lon * Math.PI * EARTH_RADIUS) / 180,
    y: Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * EARTH_RADIUS,
  };
}

function viewportBounds() {
  const rect = mapEl.getBoundingClientRect();
  const centerX = lonToX(state.center.lon, state.zoom);
  const centerY = latToY(state.center.lat, state.zoom);
  const westX = centerX - rect.width / 2;
  const eastX = centerX + rect.width / 2;
  const northY = centerY - rect.height / 2;
  const southY = centerY + rect.height / 2;

  return {
    north: yToLat(northY, state.zoom),
    south: yToLat(southY, state.zoom),
    west: xToLon(westX, state.zoom),
    east: xToLon(eastX, state.zoom),
  };
}

function projectedBbox() {
  const bounds = viewportBounds();
  const sw = mercatorMeters(bounds.south, bounds.west);
  const ne = mercatorMeters(bounds.north, bounds.east);
  return `${sw.x},${sw.y},${ne.x},${ne.y}`;
}

function displaySize() {
  const rect = mapEl.getBoundingClientRect();
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  return `${Math.round(rect.width * scale)},${Math.round(rect.height * scale)}`;
}

function screenPoint(lat, lon, zoom = state.zoom) {
  const rect = mapEl.getBoundingClientRect();
  const centerX = lonToX(state.center.lon, zoom);
  const centerY = latToY(state.center.lat, zoom);
  return {
    x: lonToX(lon, zoom) - centerX + rect.width / 2,
    y: latToY(lat, zoom) - centerY + rect.height / 2,
  };
}

function renderBasemap() {
  const rect = mapEl.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  basemap.width = Math.round(rect.width * scale);
  basemap.height = Math.round(rect.height * scale);
  basemap.style.width = `${rect.width}px`;
  basemap.style.height = `${rect.height}px`;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const gradient = ctx.createLinearGradient(0, 0, 0, rect.height);
  gradient.addColorStop(0, "#162128");
  gradient.addColorStop(1, "#0e151a");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, rect.width, rect.height);

  drawGrid(rect);
  drawRoads(rect);
  drawPlaces(rect);
}

function drawGrid(rect) {
  const bounds = viewportBounds();
  const step = state.zoom >= 9 ? 0.25 : state.zoom >= 7 ? 0.5 : 1;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.fillStyle = "rgba(247,251,255,0.52)";
  ctx.font = "11px system-ui, sans-serif";

  for (let lat = Math.floor(bounds.south / step) * step; lat <= bounds.north; lat += step) {
    const a = screenPoint(lat, bounds.west);
    const b = screenPoint(lat, bounds.east);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (let lon = Math.floor(bounds.west / step) * step; lon <= bounds.east; lon += step) {
    const a = screenPoint(bounds.south, lon);
    const b = screenPoint(bounds.north, lon);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.fillText(`${state.center.lat.toFixed(2)}, ${state.center.lon.toFixed(2)}  z${state.zoom}`, 14, rect.height - 118);
}

function drawRoads(rect) {
  for (const road of ROADS) {
    ctx.beginPath();
    road.points.forEach(([lat, lon], index) => {
      const p = screenPoint(lat, lon);
      if (index === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.lineWidth = road.width + 2;
    ctx.strokeStyle = "rgba(0,0,0,0.34)";
    ctx.stroke();
    ctx.lineWidth = road.width;
    ctx.strokeStyle = road.color;
    ctx.stroke();

    const mid = road.points[Math.floor(road.points.length / 2)];
    const label = screenPoint(mid[0], mid[1]);
    if (label.x > -40 && label.x < rect.width + 40 && label.y > -20 && label.y < rect.height + 20) {
      ctx.fillStyle = "rgba(10,13,16,0.72)";
      ctx.fillRect(label.x - 18, label.y - 11, 36, 18);
      ctx.fillStyle = "#f7fbff";
      ctx.font = "700 10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(road.name, label.x, label.y + 3);
      ctx.textAlign = "start";
    }
  }
}

function drawPlaces(rect) {
  ctx.font = "700 12px system-ui, sans-serif";
  for (const place of PLACES) {
    const p = screenPoint(place.lat, place.lon);
    if (p.x < -50 || p.x > rect.width + 50 || p.y < -20 || p.y > rect.height + 20) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, place.name === "Normal" ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = place.name === "Normal" ? "#2ee89d" : "rgba(247,251,255,0.82)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.stroke();
    ctx.fillStyle = "#f7fbff";
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = 3;
    ctx.strokeText(place.name, p.x + 7, p.y - 7);
    ctx.fillText(place.name, p.x + 7, p.y - 7);
  }
}

function radarUrl(timeMs) {
  const params = new URLSearchParams({
    bbox: projectedBbox(),
    bboxSR: "3857",
    imageSR: "3857",
    size: displaySize(),
    format: "png32",
    transparent: "true",
    f: "image",
  });

  if (timeMs) params.set("time", String(timeMs));
  return `${RADAR_SERVICE}?${params.toString()}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatTime(ms) {
  if (!ms) return "Latest radar";
  const date = new Date(ms);
  const hours = date.getHours();
  const mins = pad(date.getMinutes());
  const suffix = hours >= 12 ? "PM" : "AM";
  return `${hours % 12 || 12}:${mins} ${suffix}`;
}

function nearestFrameTime(minutesAgo = 0) {
  const now = Date.now() - minutesAgo * 60_000;
  return Math.floor(now / 300_000) * 300_000;
}

function frameTimes() {
  return Array.from({ length: 10 }, (_, index) => nearestFrameTime((9 - index) * 5));
}

function loadRadar(timeMs = 0, { quiet = false } = {}) {
  const requestId = ++state.requestId;
  const url = radarUrl(timeMs);
  state.loadStarted = performance.now();

  if (!quiet) {
    setStatus("Loading");
    $("timestamp").textContent = timeMs ? `Radar ${formatTime(timeMs)}` : "Latest radar";
  }

  const image = new Image();
  image.className = "radar-frame";
  image.decoding = "async";
  image.style.opacity = state.opacity;

  image.onload = () => {
    if (requestId !== state.requestId && !state.playTimer) return;
    radarEl.replaceChildren(image);
    state.radarImage = image;
    state.lastGoodFrame = { url, label: formatTime(timeMs), timeMs };
    setStatus(state.playTimer ? "Loop" : "Live");
    $("timestamp").textContent = timeMs ? `Radar ${formatTime(timeMs)}` : "Latest radar";
    $("latency").textContent = `${Math.round(performance.now() - state.loadStarted)} ms`;
  };

  image.onerror = () => {
    if (state.lastGoodFrame) {
      setStatus("Cached", "warn");
      $("timestamp").textContent = `Holding ${state.lastGoodFrame.label}`;
      $("latency").textContent = "retrying";
      window.setTimeout(() => loadRadar(timeMs, { quiet: true }), 1400);
      return;
    }

    setStatus("No radar", "bad");
    $("latency").textContent = "failed";
  };

  image.src = url;
}

const refreshAfterMove = debounce(() => {
  if (!state.playTimer) loadRadar(0);
}, 280);

function renderAll() {
  renderBasemap();
  refreshAfterMove();
}

function setCenterFromPixels(centerX, centerY, zoom = state.zoom) {
  state.center.lon = xToLon(centerX, zoom);
  state.center.lat = clamp(yToLat(centerY, zoom), -85, 85);
}

function panBy(dx, dy) {
  const centerX = lonToX(state.center.lon, state.zoom) - dx;
  const centerY = latToY(state.center.lat, state.zoom) - dy;
  setCenterFromPixels(centerX, centerY);
  renderBasemap();
}

function zoomBy(delta, originX = mapEl.clientWidth / 2, originY = mapEl.clientHeight / 2) {
  const oldZoom = state.zoom;
  const newZoom = clamp(Math.round(state.zoom + delta), 3, 13);
  if (newZoom === oldZoom) return;

  const oldCenterX = lonToX(state.center.lon, oldZoom);
  const oldCenterY = latToY(state.center.lat, oldZoom);
  const worldX = oldCenterX + originX - mapEl.clientWidth / 2;
  const worldY = oldCenterY + originY - mapEl.clientHeight / 2;
  const scale = 2 ** (newZoom - oldZoom);
  const newCenterX = worldX * scale - originX + mapEl.clientWidth / 2;
  const newCenterY = worldY * scale - originY + mapEl.clientHeight / 2;

  state.zoom = newZoom;
  setCenterFromPixels(newCenterX, newCenterY, newZoom);
  renderAll();
}

function useLocation() {
  if (!navigator.geolocation) {
    setStatus("No GPS", "bad");
    return;
  }

  setStatus("Locating");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.center = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      };
      state.zoom = 9;
      renderBasemap();
      loadRadar(0);
    },
    () => {
      setStatus("GPS off", "warn");
      loadRadar(0);
    },
    { enableHighAccuracy: false, timeout: 5000, maximumAge: 600000 },
  );
}

function toggleLoop() {
  const button = $("playBtn");

  if (state.playTimer) {
    clearInterval(state.playTimer);
    state.playTimer = null;
    button.innerHTML = "<span>▶</span>";
    loadRadar(0);
    return;
  }

  const frames = frameTimes();
  state.frameIndex = 0;
  button.innerHTML = "<span>Ⅱ</span>";
  setStatus("Loop");
  loadRadar(frames[state.frameIndex], { quiet: true });
  state.playTimer = window.setInterval(() => {
    state.frameIndex = (state.frameIndex + 1) % frames.length;
    loadRadar(frames[state.frameIndex], { quiet: true });
  }, 700);
}

mapEl.addEventListener("pointerdown", (event) => {
  mapEl.setPointerCapture(event.pointerId);
  state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (state.pointers.size === 2) {
    const points = [...state.pointers.values()];
    state.pinchStart = {
      distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y),
      zoom: state.zoom,
    };
  }
});

mapEl.addEventListener("pointermove", (event) => {
  if (!state.pointers.has(event.pointerId)) return;
  const previous = state.pointers.get(event.pointerId);
  state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (state.pointers.size === 1) {
    panBy(event.clientX - previous.x, event.clientY - previous.y);
  } else if (state.pointers.size === 2 && state.pinchStart) {
    const points = [...state.pointers.values()];
    const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    const delta = Math.round(Math.log2(distance / state.pinchStart.distance));
    const nextZoom = clamp(state.pinchStart.zoom + delta, 3, 13);
    if (nextZoom !== state.zoom) {
      state.zoom = nextZoom;
      renderAll();
    }
  }
});

function endPointer(event) {
  state.pointers.delete(event.pointerId);
  if (state.pointers.size === 0) {
    state.pinchStart = null;
    refreshAfterMove();
  }
}

mapEl.addEventListener("pointerup", endPointer);
mapEl.addEventListener("pointercancel", endPointer);
mapEl.addEventListener("dblclick", (event) => zoomBy(1, event.clientX, event.clientY));

$("zoomInBtn").addEventListener("click", () => zoomBy(1));
$("zoomOutBtn").addEventListener("click", () => zoomBy(-1));
$("locateBtn").addEventListener("click", useLocation);
$("refreshBtn").addEventListener("click", () => loadRadar(0));
$("playBtn").addEventListener("click", toggleLoop);
$("opacitySlider").addEventListener("input", (event) => {
  state.opacity = Number(event.target.value) / 100;
  if (state.radarImage) state.radarImage.style.opacity = state.opacity;
});

window.addEventListener("resize", renderAll);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

renderBasemap();
loadRadar(0);
window.setTimeout(useLocation, 250);
