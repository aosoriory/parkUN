// Cloudflare Worker "park-estadistica": cada minuto (entre las 6:00 y las 21:00, hora de Madrid)
// lee la página de aparcamientos de la UNAV y guarda en D1 las plazas libres de cada parking (tabla lecturas).
// Franja rápida (8:45–9:30): además, dentro de cada minuto lee la página cada 2 s y anota solo los CAMBIOS,
// con el segundo exacto (tabla cambios), para ver cuándo entran y salen coches.
// Necesita: un enlace (binding) a la base D1 "parkun-estadistica" con el nombre DB, y un Cron Trigger "* * * * *".
const TARGET = "https://www.unav.edu/web/gestion-de-espacios/aparcamientos";
const DESDE_MIN = 6 * 60;      // 6:00
const HASTA_MIN = 21 * 60;     // 21:00 (incluida)
const RAPIDA_DESDE = 8 * 60 + 45;   // 8:45
const RAPIDA_HASTA = 9 * 60 + 30;   // 9:30 (incluida)
const PASO_MS = 2000;               // una lectura cada 2 s
const LECTURAS_POR_MINUTO = 28;     // 28 × 2 s = 56 s; el límite gratuito es de 50 peticiones por ejecución
const SIN_ELECTRICAS = ["P06", "P07", "P13"];

function madrid(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}`, horaSeg: `${p.hour}:${p.minute}:${p.second}`, min: Number(p.hour) * 60 + Number(p.minute) };
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

// Trozo de la página con las dos listas de parkings (lo único que interesa comparar).
function bloque(html) {
  const i = html.indexOf("P01");
  if (i < 0) return null;
  const a = html.lastIndexOf("<ul", i);
  const b1 = html.indexOf("</ul>", i);
  if (a < 0 || b1 < 0) return null;
  const b2 = html.indexOf("</ul>", b1 + 5);
  return html.slice(a, (b2 < 0 ? b1 : b2) + 5);
}

async function leer() {
  const r = await fetch(TARGET, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "es-ES,es;q=0.9" }, signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}

const dormir = ms => new Promise(r => setTimeout(r, ms));

// Dentro de un minuto: lee cada 2 s y apunta solo lo que cambia. Escribe una sola vez al final.
async function rapida(env, t0) {
  const previo = new Map();
  try {
    const { results } = await env.DB.prepare("SELECT code, libres, electricas, ts_ms FROM estado").all();
    for (const f of results || []) if (t0 - f.ts_ms < 10 * 60 * 1000) previo.set(f.code, f);
  } catch (e) { /* sin estado previo: la primera lectura será el punto de partida */ }
  const ahora = new Map(previo);
  const cambios = [];
  let ultimo = null, fallos = 0, ultimoError = "";
  for (let i = 0; i < LECTURAS_POR_MINUTO; i++) {
    const espera = t0 + i * PASO_MS - Date.now();
    if (espera > 0) await dormir(espera);
    const t = Date.now();
    try {
      const html = await leer();
      const b = bloque(html);
      if (!b) throw new Error("página sin lista de parkings");
      if (b === ultimo) continue;          // nada ha cambiado: no se analiza (ahorra CPU)
      ultimo = b;
      const { gen, ele } = interpretar(b);
      const { fecha, horaSeg } = madrid(t);
      for (const c of new Set([...Object.keys(gen), ...Object.keys(ele)])) {
        const l = gen[c] ?? null, e = ele[c] ?? null, p = ahora.get(c);
        if (!p || p.libres !== l || p.electricas !== e) {
          cambios.push([t, fecha, horaSeg, c, l, e, p ? p.libres : null]);
          ahora.set(c, { code: c, libres: l, electricas: e, ts_ms: t });
        }
      }
    } catch (e) { fallos++; ultimoError = String((e && e.message) || e); }
  }
  const sentencias = cambios.map(c => env.DB.prepare(
    "INSERT INTO cambios (ts_ms, fecha, hora, code, libres, electricas, libres_antes) VALUES (?,?,?,?,?,?,?)").bind(...c));
  for (const [c, v] of ahora) sentencias.push(env.DB.prepare(
    "INSERT OR REPLACE INTO estado (code, libres, electricas, ts_ms) VALUES (?,?,?,?)").bind(c, v.libres, v.electricas, Date.now()));
  if (fallos >= LECTURAS_POR_MINUTO / 2) {
    const m = madrid(t0);
    sentencias.push(env.DB.prepare("INSERT INTO errores (ts, fecha, hora, mensaje) VALUES (?,?,?,?)")
      .bind(Math.floor(t0 / 1000), m.fecha, m.hora, "franja rápida: " + fallos + " lecturas fallidas (" + ultimoError + ")"));
  }
  if (sentencias.length) await env.DB.batch(sentencias);
}

export default {
  async scheduled(event, env, ctx) {
    const ts = event.scheduledTime || Date.now();
    const { min } = madrid(ts);
    if (min < DESDE_MIN || min > HASTA_MIN) return;   // fuera de horario: no hace nada
    ctx.waitUntil(registrar(env, ts));
    if (min >= RAPIDA_DESDE && min <= RAPIDA_HASTA) ctx.waitUntil(rapida(env, Date.now()));
  },
  async fetch() {
    return new Response("park-estadistica: solo guarda datos; no hay nada que ver aquí.", { status: 404 });
  },
};
