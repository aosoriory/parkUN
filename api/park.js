// Proxy de respaldo en Vercel: devuelve la página de aparcamientos de la UNAV con CORS.
// Va aparte del Worker de Cloudflare para que, si las operadoras bloquean IPs de un proveedor
// (partidos de LaLiga), la app pueda llegar por el otro.
const TARGET = "https://www.unav.edu/web/gestion-de-espacios/aparcamientos";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.status(204).end();
    return;
  }
  let err = "";
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(TARGET, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "es-ES,es;q=0.9" },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) { err = "HTTP " + r.status; continue; }
      const text = await r.text();
      if (text.length < 500) { err = "respuesta demasiado corta"; continue; }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(text);
      return;
    } catch (e) {
      err = String((e && e.message) || e);
    }
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.status(502).send("La UNAV no responde (" + err + ")");
};
