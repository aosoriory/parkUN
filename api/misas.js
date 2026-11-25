// Proxy en Vercel para los horarios de misas de la Capellanía de la UNAV.
// Lee https://www.unav.edu/web/capellania/oratorios-y-misas y devuelve en JSON las misas
// de cada campus: [{ city, t, days, label, building, note }]. days: 0 = domingo … 6 = sábado;
// note: { día: "en inglés" }. La página tiene una tabla grande por campus (fila = hora,
// columnas = lunes…domingo) y, además, tablas pequeñas para el móvil, que se ignoran.
// Orden: página de la UNAV (2 intentos) -> última copia buena en memoria (hasta 24 h) -> 502.
// Si la lectura no tiene buena pinta (pocas misas en Pamplona), se da por fallida y la app
// usa su horario copiado a mano.
const TARGET = "https://www.unav.edu/web/capellania/oratorios-y-misas";
const STALE_MAX_S = 24 * 3600;
const HEADERS = { "User-Agent": "Mozilla/5.0", "Accept": "text/html", "Accept-Language": "es-ES,es;q=0.9" };

let last = null; // { t: ms, body }

// Nombre que pone la Capellanía -> edificio de Quodus (para los favoritos) y cómo se llama en la app.
const PLACES = {
  "biblioteca central": { building: "Edificio Biblioteca Central", label: "Biblioteca" },
  "edificio central": { building: "Edificio Central", label: "Central" },
  "teologia": { building: "Edificio Facultades Eclesiásticas", label: "Teología" },
  "ciencias": { building: "Edificio de Ciencias", label: "Ciencias" },
  "arquitectura": { building: "Edificio de Arquitectura", label: "Arquitectura" },
  "amigos": { building: "Edificio Amigos", label: "Amigos" },
  "comunicacion": { building: "Edificio FCOM", label: "FCOM" },
  "oratorio de ibaeta": { building: "Edificio Ibaeta", label: "Ibaeta" },
  "ibaeta": { building: "Edificio Ibaeta", label: "Ibaeta" },
  "edificio alumni": { building: "Edificio Alumni", label: "Alumni" },
  "alumni": { building: "Edificio Alumni", label: "Alumni" },
};
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const DAY_OF_COL = [1, 2, 3, 4, 5, 6, 0]; // columnas lunes…domingo -> getDay()

function decode(s) {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, (e) => ({ "&aacute;": "á", "&eacute;": "é", "&iacute;": "í", "&oacute;": "ó", "&uacute;": "ú", "&ntilde;": "ñ", "&Aacute;": "Á", "&Eacute;": "É", "&Iacute;": "Í", "&Oacute;": "Ó", "&Uacute;": "Ú", "&Ntilde;": "Ñ" }[e] || " "))
    .replace(/\s+/g, " ").trim();
}

function cityBefore(html, pos) {
  // El título o identificador más cercano por encima de la tabla dice el campus.
  const before = norm(html.slice(Math.max(0, pos - 6000), pos));
  const idx = { pamplona: before.lastIndexOf("pamplona"), sansebastian: Math.max(before.lastIndexOf("sansebastian"), before.lastIndexOf("san sebastian")), madrid: before.lastIndexOf("madrid") };
  const best = Object.entries(idx).sort((a, b) => b[1] - a[1])[0];
  return best[1] >= 0 ? best[0] : null;
}

// "Ciencias y Arquitectura (en inglés)" -> [{Ciencias}, {Arquitectura, en inglés}]
// (el paréntesis va con el último sitio: así lo aclaró Al para el miércoles a las 13:30)
function splitCell(text) {
  let note = null;
  const m = text.match(/\(([^)]*)\)\s*$/);
  if (m) { note = m[1].trim(); text = text.slice(0, m.index).trim(); }
  if (!text || text === "-" || text === "–") return [];
  const parts = text.split(/\s+y\s+/i).map((p) => p.trim()).filter(Boolean);
  return parts.map((p, i) => {
    const known = PLACES[norm(p)];
    return {
      label: known ? known.label : p,
      building: known ? known.building : null,
      note: i === parts.length - 1 ? note : null,
    };
  });
}

function parse(html) {
  const out = {}; // clave city|t|label -> misa
  const re = /<table[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = re.exec(html))) {
    const rows = [...tm[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => decode(c[1])));
    if (!rows.length || rows[0].length < 8 || !/^horario/i.test(rows[0][0])) continue; // solo las tablas grandes
    const city = cityBefore(html, tm.index);
    if (!city) continue;
    for (const row of rows.slice(1)) {
      const hm = (row[0] || "").match(/(\d{1,2})[:.](\d{2})/);
      if (!hm) continue;
      const t = Number(hm[1]) + ":" + hm[2];
      row.slice(1, 8).forEach((cell, col) => {
        const day = DAY_OF_COL[col];
        for (const p of splitCell(cell || "")) {
          const k = city + "|" + t + "|" + p.label;
          const e = out[k] || (out[k] = { city, t, days: [], label: p.label, building: p.building, note: {} });
          if (!e.days.includes(day)) e.days.push(day);
          if (p.note) e.note[day] = p.note;
        }
      });
    }
  }
  return Object.values(out).map((e) => (Object.keys(e.note).length ? e : (delete e.note, e)));
}

async function getHtml() {
  let err = "";
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(TARGET, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) {
      err = String((e && e.message) || e);
    }
  }
  throw new Error("unav: " + err);
}

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-Stale-Age");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.status(204).end();
    return;
  }
  try {
    const misas = parse(await getHtml());
    if (misas.filter((m) => m.city === "pamplona").length < 5) throw new Error("la tabla no tiene buena pinta (" + misas.length + " misas)");
    const body = JSON.stringify({ t: Date.now(), source: TARGET, misas });
    last = { t: Date.now(), body };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(body);
  } catch (e) {
    const age = last ? Math.round((Date.now() - last.t) / 1000) : null;
    if (last && age <= STALE_MAX_S) {
      res.setHeader("X-Stale-Age", String(age));
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.status(200).send(last.body);
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(502).send("No se pudo leer el horario de misas (" + e.message + ")");
  }
}

module.exports = handler;
module.exports.parse = parse; // para las pruebas
