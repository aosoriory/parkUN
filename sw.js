// Service worker mínimo: solo existe para que Chrome considere la app
// instalable. No cachea nada (los datos de aparcamiento deben ser
// siempre en tiempo real), simplemente deja pasar las peticiones.
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  e.respondWith(fetch(e.request));
});
