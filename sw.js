// Service worker de Ubi.
// - Los datos (/api/…, plazas, espacios, misas) van siempre a la red: deben ser en tiempo real.
//   Sin conexión, la propia app muestra los últimos guardados en el móvil, con aviso.
// - La app (página, iconos, manifiesto, estadística, letras) se pide a la red y se guarda una copia;
//   si no hay red, se sirve la copia, para que la app abra igualmente sin conexión.
const CACHE = "ubi-app-v1";
const PRECACHE = ["./", "./index.html", "./manifest.json", "./icon-192.png?v=4", "./icon-180.png?v=4", "./perfil.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const mismaWeb = url.origin === self.location.origin;
  const letras = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if ((mismaWeb && url.pathname.startsWith("/api/")) || (!mismaWeb && !letras)) return;   // datos: solo red
  e.respondWith(
    fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque")) {
        const copia = res.clone();
        // la página se guarda sin parámetros (?tab=…) para que sirva para cualquier atajo
        const clave = req.mode === "navigate" ? "./index.html" : req;
        caches.open(CACHE).then(c => c.put(clave, copia)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req.mode === "navigate" ? "./index.html" : req, { ignoreSearch: req.mode === "navigate" })
      .then(r => r || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});
