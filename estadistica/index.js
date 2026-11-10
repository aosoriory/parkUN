// Cloudflare Worker "park-estadistica": cada minuto (entre las 6:00 y las 21:00, hora de Madrid)
// lee la página de aparcamientos de la UNAV y guarda en D1 las plazas libres de cada parking.
// Necesita: un enlace (binding) a la base D1 "parkun-estadistica" con el nombre DB, y un Cron Trigger "* * * * *".
const TARGET = "https://www.unav.edu/web/gestion-de-espacios/aparcamientos";
const DESDE_MIN = 6 * 60;      // 6:00
const HASTA_MIN = 21 * 60;     // 21:00 (incluida)
const SIN_ELECTRICAS = ["P06", "P07", "P13"];

function madrid(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

function texto(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function codigo(t) {
  const m = t.match(/P(\d{2})/);
  if (m) return "P" + m[1];
  const l = t.toLowerCase();
  if (l.includes("madrid")) return "P10";
  if (l.includes("ibaeta")) return "P11";
  if (l.includes("miram")) return "P12";
  if (l.includes("igara")) return "P13";
  return null;
}
function ultimoNumero(t) {
  const n = t.match(/\d+/g);
  return n && n.length ? parseInt(n[n.length - 1], 10) : null;
}
// Misma lógica que la app: la primera lista válida son las plazas generales y la segunda, las eléctricas.
function interpretar(html) {
  const listas = [...html.matchAll(/<ul[^>]*>([\s\S]*?)<\/ul>/gi)]
    .map(m => m[1])
    .filter(u => { const t = texto(u); return t.includes("P01") || t.includes("COMEDORES"); });
  const gen = {}, ele = {};
  const lis = u => [...u.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(m => texto(m[1]));
  if (listas[0]) for (const t of lis(listas[0])) { const c = codigo(t); if (c) gen[c] = ultimoNumero(t); }
  if (listas[1]) for (const t of lis(listas[1])) {
    const c = codigo(t);
    if (c && !SIN_ELECTRICAS.includes(c)) { const n = ultimoNumero(t); if (n !== null) ele[c] = n; }
  }
  return { gen, ele };
}

async function registrar(env, ts) {
  const { fecha, hora } = madrid(ts);
  let resultado = "";
  try {
    let html = "", err = "";
    for (let i = 0; i < 2 && !html; i++) {
      try {
        const r = await fetch(TARGET, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "es-ES,es;q=0.9" }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) { err = "HTTP " + r.status; continue; }
        const t = await r.text();
        if (t.length < 500) { err = "respuesta demasiado corta"; continue; }
        html = t;
      } catch (e) { err = String((e && e.message) || e); }
    }
    if (!html) throw new Error(err || "sin respuesta");
    const { gen, ele } = interpretar(html);
    const codes = [...new Set([...Object.keys(gen), ...Object.keys(ele)])].sort();
    if (!codes.length) throw new Error("no se reconoció ningún aparcamiento");
    resultado = codes.length + " parkings guardados: " + codes.join(",");
    await env.DB.batch(codes.map(c =>
      env.DB.prepare("INSERT INTO lecturas (ts, fecha, hora, code, libres, electricas) VALUES (?,?,?,?,?,?)")
        .bind(Math.floor(ts / 1000), fecha, hora, c, gen[c] ?? null, ele[c] ?? null)));
  } catch (e) {
    await env.DB.prepare("INSERT INTO errores (ts, fecha, hora, mensaje) VALUES (?,?,?,?)")
      .bind(Math.floor(ts / 1000), fecha, hora, String((e && e.message) || e)).run();
    resultado = "ERROR: " + String((e && e.message) || e);
  }
  return resultado;
}

export default {
  async scheduled(event, env, ctx) {
    const ts = event.scheduledTime || Date.now();
    const { min } = madrid(ts);
    if (min < DESDE_MIN || min > HASTA_MIN) return;   // fuera de horario: no hace nada
    ctx.waitUntil(registrar(env, ts));
  },
  async fetch(request, env) {
    // /probar: una lectura de prueba a cualquier hora (guarda una fila por parking y dice qué pasó).
    if (new URL(request.url).pathname === "/probar") {
      return new Response(await registrar(env, Date.now()) + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response("park-estadistica: solo guarda datos; no hay nada que ver aquí.", { status: 404 });
  },
};
