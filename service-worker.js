const APP_CACHE = "fast-radar-app-v4";
const RADAR_CACHE = "fast-radar-runtime-v4";
const MAP_CACHE = "fast-radar-map-v4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./maplibre-gl.css",
  "./maplibre-gl.js",
  "./manifest.webmanifest",
  "./robots.txt",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => ![APP_CACHE, RADAR_CACHE, MAP_CACHE].includes(key)).map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("./index.html")));
    return;
  }

  if (url.hostname === "mapservices.weather.noaa.gov" || url.hostname === "api.weather.gov") {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.hostname === "tiles.openfreemap.org") {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});

async function networkFirst(request) {
  const cache = await caches.open(RADAR_CACHE);

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error("No network or cached response");
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(MAP_CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === "opaque")) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);

  return cached || refresh;
}
