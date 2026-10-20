// Proxy en Vercel: devuelve la página de aparcamientos de la UNAV con CORS.
// Lo usa la app de Vercel (misma dirección, /api/park) y la de GitHub como vía extra.
// Orden: UNAV directa -> proxies públicos (de servidor a servidor, sin bloqueos de operadoras)
// -> última copia buena en memoria (hasta 10 min, con X-Stale-Age) -> error 502 con el motivo.
const TARGET = "https://www.unav.edu/web/gestion-de-espacios/aparcamientos";
const STALE_MAX_S = 10 * 60;
const HEADERS = { "User-Agent": "Mozilla/5.0", "Accept-Language": "es-ES,es;q=0.9" };

// Persiste solo mientras la instancia siga "caliente"; si Vercel la apaga, se pierde (es solo un extra).
let last = null; // { t: ms, text }

async function get(url, ms) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const text = await r.text();
  if (text.length < 500) throw new Error("respuesta demasiado corta");
  return text;
}

async function direct() {
  let err = "";
  for (let i = 0; i < 2; i++) {
    try { return await get(TARGET, 5000); }
    catch (e) { err = String((e && e.message) || e); }
  }
  throw new Error("directa: " + err);
}

function viaProxies() {
  const one = (name, url) => get(url, 5000).catch((e) => { throw new Error(name + ": " + String((e && e.message) || e)); });
  return Promise.any([
    one("allorigins", "https://api.allorigins.win/raw?url=" + encodeURIComponent(TARGET)),
    one("codetabs", "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(TARGET)),
  ]);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-Stale-Age");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.status(204).end();
    return;
  }
  const errors = [];
  let text = null;
  try { text = await direct(); }
  catch (e) { errors.push(e.message); }
  if (text === null) {
    try { text = await viaProxies(); }
    catch (agg) { (agg.errors || [agg]).forEach((x) => errors.push(x.message)); }
  }
  if (text !== null) {
    last = { t: Date.now(), text };
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(text);
    return;
  }
  const age = last ? Math.round((Date.now() - last.t) / 1000) : null;
  if (last && age <= STALE_MAX_S) {
    res.setHeader("X-Stale-Age", String(age));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(last.text);
    return;
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.status(502).send("La UNAV no responde (" + errors.join(" | ") + ")");
};
