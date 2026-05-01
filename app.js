const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const RADAR_SERVICE =
  "https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer/exportImage";
const DEFAULT_CENTER = [-88.9906, 40.5142];
const EARTH_RADIUS = 6378137;
const RADAR_BUFFER = 0.85;

const state = {
  opacity: 0.82,
  selectedPoint: { lat: DEFAULT_CENTER[1], lon: DEFAULT_CENTER[0] },
  radarLoaded: null,
  radarRequestId: 0,
  radarLoadStarted: 0,
  playTimer: null,
  frameIndex: 0,
  mapReady: false,
  point: null,
  hourly: [],
  activeTab: "radar",
  lastWeatherPoint: null,
  collapsed: false,
};

const $ = (id) => document.getElementById(id);

const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLE,
  center: DEFAULT_CENTER,
  zoom: 8.3,
  minZoom: 4,
  maxZoom: 14,
  attributionControl: false,
});

map.dragRotate.disable();
map.touchZoomRotate.disableRotation();

const markerEl = document.createElement("div");
markerEl.className = "selected-marker";
const selectedMarker = new maplibregl.Marker({ element: markerEl, anchor: "center" })
  .setLngLat(DEFAULT_CENTER)
  .addTo(map);

function setStatus(text, tone = "") {
  const status = $("status");
  status.textContent = text;
  status.className = `status ${tone}`.trim();
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatClock(value) {
  if (!value) return "--";
  const date = new Date(value);
  const hours = date.getHours();
  const suffix = hours >= 12 ? "PM" : "AM";
  return `${hours % 12 || 12}:${pad(date.getMinutes())} ${suffix}`;
}

function formatShortDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  return `${date.toLocaleDateString([], { weekday: "short" })} ${formatClock(value)}`;
}

function mercatorMeters(lat, lon) {
  return {
    x: (lon * Math.PI * EARTH_RADIUS) / 180,
    y: Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * EARTH_RADIUS,
  };
}

function bufferedBounds() {
  const canvas = map.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const nw = map.unproject([-width * RADAR_BUFFER, -height * RADAR_BUFFER]);
  const ne = map.unproject([width * (1 + RADAR_BUFFER), -height * RADAR_BUFFER]);
  const se = map.unproject([width * (1 + RADAR_BUFFER), height * (1 + RADAR_BUFFER)]);
  const sw = map.unproject([-width * RADAR_BUFFER, height * (1 + RADAR_BUFFER)]);

  return {
    west: Math.min(nw.lng, sw.lng),
    east: Math.max(ne.lng, se.lng),
    north: Math.max(nw.lat, ne.lat),
    south: Math.min(sw.lat, se.lat),
    coordinates: [
      [nw.lng, nw.lat],
      [ne.lng, ne.lat],
      [se.lng, se.lat],
      [sw.lng, sw.lat],
    ],
    pixelWidth: Math.round(width * (1 + RADAR_BUFFER * 2) * Math.min(window.devicePixelRatio || 1, 2)),
    pixelHeight: Math.round(height * (1 + RADAR_BUFFER * 2) * Math.min(window.devicePixelRatio || 1, 2)),
  };
}

function radarUrl(timeMs, bounds) {
  const sw = mercatorMeters(bounds.south, bounds.west);
  const ne = mercatorMeters(bounds.north, bounds.east);
  const params = new URLSearchParams({
    bbox: `${sw.x},${sw.y},${ne.x},${ne.y}`,
    bboxSR: "3857",
    imageSR: "3857",
    size: `${Math.min(bounds.pixelWidth, 1800)},${Math.min(bounds.pixelHeight, 1800)}`,
    format: "png32",
    transparent: "true",
    f: "image",
  });

  if (timeMs) params.set("time", String(timeMs));
  return `${RADAR_SERVICE}?${params.toString()}`;
}

function nearestFrameTime(minutesAgo = 0) {
  const now = Date.now() - minutesAgo * 60_000;
  return Math.floor(now / 300_000) * 300_000;
}

function frameTimes() {
  return Array.from({ length: 10 }, (_, index) => nearestFrameTime((9 - index) * 5));
}

function loadRadar(timeMs = 0, { quiet = false } = {}) {
  if (!state.mapReady) {
    window.setTimeout(() => loadRadar(timeMs, { quiet }), 250);
    return;
  }

  const requestId = ++state.radarRequestId;
  const bounds = bufferedBounds();
  const url = radarUrl(timeMs, bounds);
  state.radarLoadStarted = performance.now();

  if (!quiet) {
    setStatus("Radar");
    $("timestamp").textContent = timeMs ? formatClock(timeMs) : "Latest";
  }

  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.onload = () => {
    if (requestId !== state.radarRequestId && !state.playTimer) return;
    putRadarImage(url, bounds.coordinates);
    state.radarLoaded = { bounds, timeMs };
    $("timestamp").textContent = timeMs ? formatClock(timeMs) : "Latest";
    $("latency").textContent = `${Math.round(performance.now() - state.radarLoadStarted)} ms`;
    setStatus(state.playTimer ? "Loop" : "Live");
  };
  image.onerror = () => {
    setStatus(state.radarLoaded ? "Cached" : "No radar", state.radarLoaded ? "warn" : "bad");
    $("latency").textContent = state.radarLoaded ? "holding" : "failed";
  };
  image.src = url;
}

function putRadarImage(url, coordinates) {
  if (!map.getSource("radar")) {
    map.addSource("radar", {
      type: "image",
      url,
      coordinates,
    });
    map.addLayer({
      id: "radar-layer",
      type: "raster",
      source: "radar",
      paint: {
        "raster-opacity": state.opacity,
        "raster-resampling": "linear",
      },
    });
    return;
  }

  map.getSource("radar").updateImage({ url, coordinates });
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
  }, 750);
}

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

function selectedPoint() {
  const point = state.selectedPoint;
  return {
    lat: Number(point.lat.toFixed(4)),
    lon: Number(point.lon.toFixed(4)),
  };
}

function distanceKm(a, b) {
  if (!a || !b) return Infinity;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/geo+json, application/ld+json, application/json",
    },
  });

  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function refreshWeather(force = false) {
  const point = selectedPoint();
  if (!force && distanceKm(state.lastWeatherPoint, point) < 8) return;
  state.lastWeatherPoint = point;

  try {
    const pointData = await fetchJson(`https://api.weather.gov/points/${point.lat},${point.lon}`);
    const props = pointData.properties;
    state.point = props;
    updatePlace(props);
    await Promise.all([loadHourly(props.forecastHourly), loadAlerts(point), loadDiscussion(props.cwa)]);
  } catch (error) {
    $("hourlySummary").textContent = "Forecast unavailable";
    $("discussionText").textContent = "Could not load Weather.gov data.";
  }
}

function setSelectedPoint(point, { refresh = true } = {}) {
  state.selectedPoint = {
    lat: Number(point.lat),
    lon: Number(point.lon),
  };
  selectedMarker.setLngLat([state.selectedPoint.lon, state.selectedPoint.lat]);
  $("placeLabel").textContent = "Selected point";
  if (refresh) refreshWeather(true);
}

function updatePlace(props) {
  const loc = props.relativeLocation?.properties;
  $("placeLabel").textContent = loc ? `${loc.city}, ${loc.state} · ${props.cwa}` : props.cwa || "Selected point";
  $("discussionOffice").textContent = props.cwa ? `NWS ${props.cwa}` : "NWS";
}

async function loadHourly(url) {
  const data = await fetchJson(url);
  state.hourly = data.properties.periods || [];
  renderHourly(data.properties);
}

function renderHourly(props) {
  const hours = state.hourly.slice(0, 36);
  const first = hours[0];
  $("nowTemp").textContent = first ? `${first.temperature}°` : "--";
  $("hourlySummary").textContent = first
    ? `${first.temperature}° · ${first.shortForecast}`
    : "No hourly forecast";
  $("forecastUpdated").textContent = props.updateTime ? `Updated ${formatClock(props.updateTime)}` : "--";

  const list = $("hourlyList");
  list.replaceChildren(
    ...hours.slice(0, 18).map((hour) => {
      const card = document.createElement("div");
      card.className = "hourly-card";
      const pop = hour.probabilityOfPrecipitation?.value ?? 0;
      card.innerHTML = `<b>${formatClock(hour.startTime).replace(":00 ", " ")}</b>
        <span>${hour.temperature}° · ${pop}%</span>
        <span>${hour.windSpeed} ${hour.windDirection}</span>
        <span>${hour.shortForecast}</span>`;
      return card;
    }),
  );

  drawHourlyChart(hours);
}

function parseWind(value) {
  if (!value) return 0;
  const match = String(value).match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function drawHourlyChart(hours) {
  const canvas = $("hourlyChart");
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * scale);
  canvas.height = Math.round(rect.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  if (!hours.length) return;

  const padX = 26;
  const top = 16;
  const bottom = rect.height - 24;
  const plotW = rect.width - padX * 2;
  const temps = hours.map((h) => h.temperature);
  const winds = hours.map((h) => parseWind(h.windSpeed));
  const pops = hours.map((h) => h.probabilityOfPrecipitation?.value ?? 0);
  const minTemp = Math.min(...temps) - 3;
  const maxTemp = Math.max(...temps) + 3;
  const maxWind = Math.max(20, ...winds);
  const x = (index) => padX + (index / Math.max(hours.length - 1, 1)) * plotW;
  const yTemp = (temp) => bottom - ((temp - minTemp) / (maxTemp - minTemp || 1)) * (bottom - top);
  const yWind = (wind) => bottom - (wind / maxWind) * (bottom - top);

  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = top + (i / 3) * (bottom - top);
    ctx.beginPath();
    ctx.moveTo(padX, y);
    ctx.lineTo(rect.width - padX, y);
    ctx.stroke();
  }

  pops.forEach((pop, index) => {
    const barH = (pop / 100) * (bottom - top);
    ctx.fillStyle = "rgba(104,167,255,0.42)";
    ctx.fillRect(x(index) - 3, bottom - barH, 6, barH);
  });

  drawLine(ctx, temps.map((temp, index) => [x(index), yTemp(temp)]), "#ff7b8b", 2.5);
  drawLine(ctx, winds.map((wind, index) => [x(index), yWind(wind)]), "#2ee89d", 2);

  ctx.fillStyle = "rgba(248,251,255,0.72)";
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillText(`${Math.round(maxTemp)}°`, 4, top + 4);
  ctx.fillText(`${Math.round(minTemp)}°`, 4, bottom);
  ctx.fillStyle = "#ff7b8b";
  ctx.fillText("temp", rect.width - 58, 16);
  ctx.fillStyle = "#68a7ff";
  ctx.fillText("rain", rect.width - 58, 30);
  ctx.fillStyle = "#2ee89d";
  ctx.fillText("wind", rect.width - 58, 44);
}

function drawLine(ctx, points, color, width) {
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

async function loadAlerts(point) {
  const data = await fetchJson(`https://api.weather.gov/alerts/active?point=${point.lat},${point.lon}`);
  const alerts = data.features || [];
  const pill = $("alertPill");
  const list = $("alertsList");

  if (!alerts.length) {
    pill.textContent = "No alerts";
    pill.classList.remove("active");
    list.textContent = "No active alerts for the selected point.";
    return;
  }

  pill.textContent = `${alerts.length} alert${alerts.length === 1 ? "" : "s"}`;
  pill.classList.add("active");
  list.replaceChildren(
    ...alerts.slice(0, 4).map((alert) => {
      const props = alert.properties;
      const item = document.createElement("div");
      item.className = "alert-item";
      item.innerHTML = `<strong>${props.event}</strong><span>${props.headline || props.description || ""}</span>`;
      return item;
    }),
  );
}

async function loadDiscussion(office) {
  if (!office) return;
  const list = await fetchJson(`https://api.weather.gov/products/types/AFD/locations/${office}`);
  const latest = list["@graph"]?.[0];
  if (!latest) throw new Error("No AFD found");
  const product = await fetchJson(`https://api.weather.gov/products/${latest.id}`);
  renderDiscussion(product);
}

function renderDiscussion(product) {
  $("discussionTime").textContent = formatShortDate(product.issuanceTime);
  const text = product.productText || "";
  $("keyMessages").textContent = extractKeyMessages(text);
  $("discussionText").textContent = cleanDiscussion(text);
}

function extractKeyMessages(text) {
  const match = text.match(/\.KEY MESSAGES\.\.\.([\s\S]*?)&&/i);
  if (!match) return "No key messages section in the latest discussion.";
  return match[1]
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+/gm, "")
    .trim();
}

function cleanDiscussion(text) {
  return text
    .replace(/^\s*000\s*/i, "")
    .replace(/^FXUS[\s\S]*?Area Forecast Discussion/i, "Area Forecast Discussion")
    .replace(/\n&&\n/g, "\n\n")
    .trim();
}

const refreshAfterMove = debounce(() => {
  if (!state.playTimer) loadRadar(0, { quiet: true });
}, 650);

function useLocation() {
  if (!navigator.geolocation) {
    setStatus("No GPS", "bad");
    return;
  }

  setStatus("Locating");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      setSelectedPoint(
        {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        },
        { refresh: false },
      );
      map.easeTo({
        center: [position.coords.longitude, position.coords.latitude],
        zoom: Math.max(map.getZoom(), 9),
        duration: 550,
      });
      window.setTimeout(() => {
        loadRadar(0);
        refreshWeather(true);
      }, 600);
    },
    () => {
      setStatus("GPS off", "warn");
      refreshWeather(true);
    },
    { enableHighAccuracy: false, timeout: 5000, maximumAge: 600000 },
  );
}

function switchTab(tabName) {
  state.activeTab = tabName;
  $("sheet").classList.toggle("radar-active", tabName === "radar");
  if (tabName !== "radar") setCollapsed(false);
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${tabName}Panel`);
  });
  if (tabName === "hourly") drawHourlyChart(state.hourly.slice(0, 36));
}

function setCollapsed(collapsed) {
  state.collapsed = collapsed && state.activeTab === "radar";
  $("sheet").classList.toggle("collapsed", state.collapsed);
  document.body.classList.toggle("radar-ui-collapsed", state.collapsed);
  $("collapseBtn").setAttribute("aria-label", state.collapsed ? "Expand radar UI" : "Minimize radar UI");
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

$("zoomInBtn").addEventListener("click", () => map.zoomIn({ duration: 220 }));
$("zoomOutBtn").addEventListener("click", () => map.zoomOut({ duration: 220 }));
$("locateBtn").addEventListener("click", useLocation);
$("refreshBtn").addEventListener("click", () => {
  loadRadar(0);
  refreshWeather(true);
});
$("playBtn").addEventListener("click", toggleLoop);
$("collapseBtn").addEventListener("click", () => setCollapsed(!state.collapsed));
$("opacitySlider").addEventListener("input", (event) => {
  state.opacity = Number(event.target.value) / 100;
  if (map.getLayer("radar-layer")) map.setPaintProperty("radar-layer", "raster-opacity", state.opacity);
});

map.on("load", () => {
  state.mapReady = true;
  setSelectedPoint({ lat: DEFAULT_CENTER[1], lon: DEFAULT_CENTER[0] }, { refresh: false });
  loadRadar(0);
  refreshWeather(true);
  window.setTimeout(useLocation, 250);
});

map.on("click", (event) => {
  setSelectedPoint({ lat: event.lngLat.lat, lon: event.lngLat.lng });
});

map.on("moveend", refreshAfterMove);
map.on("zoomend", refreshAfterMove);
window.addEventListener("resize", () => drawHourlyChart(state.hourly.slice(0, 36)));

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
