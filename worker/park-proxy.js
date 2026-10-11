// Cloudflare Worker "park-proxy": devuelve la página de aparcamientos de la UNAV con CORS.
// Mejoras respecto a la versión anterior:
//  - captura los errores (antes, si la UNAV tardaba o fallaba, el Worker lanzaba una excepción
//    y el navegador solo veía "Failed to fetch", sin poder saber qué pasó);
//  - tiempo máximo de 6 s por intento y hasta 3 intentos;
//  - guarda la última copia buena y, si la UNAV no responde, sirve esa copia (máx. 10 min)
//    avisando con la cabecera X-Stale-Age (segundos);
//  - si no hay nada que servir, responde 502 CON cabeceras CORS, para que la app vea el motivo.
const TARGET = "https://www.unav.edu/web/gestion-de-espacios/aparcamientos";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "X-Stale-Age, X-Source",
  "Cache-Control": "no-store",
};
const HTML = { "Content-Type": "text/html; charset=utf-8" };
const MAX_STALE_MS = 10 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" } });
    }
    const cache = caches.default;
    const key = new Request("https://park-proxy.internal/last-good");
    let err = "";
    for (let i = 0; i < 3; i++) {
      try {
        const resp = await fetch(TARGET, {
          headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "es-ES,es;q=0.9" },
          signal: AbortSignal.timeout(6000),
        });
        if (!resp.ok) { err = "HTTP " + resp.status; continue; }
        const text = await resp.text();
        if (text.length < 500) { err = "respuesta demasiado corta"; continue; }
        ctx.waitUntil(cache.put(key, new Response(text, { headers: { ...HTML, "Cache-Control": "max-age=3600", "X-Saved": String(Date.now()) } })));
        return new Response(text, { status: 200, headers: { ...CORS, ...HTML, "X-Source": "live" } });
      } catch (e) {
        err = String(e && e.message || e);
      }
    }
    const old = await cache.match(key);
    if (old) {
      const age = Date.now() - Number(old.headers.get("X-Saved") || 0);
      if (age <= MAX_STALE_MS) {
        return new Response(await old.text(), { status: 200, headers: { ...CORS, ...HTML, "X-Source": "stale", "X-Stale-Age": String(Math.round(age / 1000)) } });
      }
    }
    return new Response("La UNAV no responde (" + err + ")", { status: 502, headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } });
  },
};
