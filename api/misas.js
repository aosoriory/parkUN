// Proxy en Vercel para los horarios de misas de la Capellanía de la UNAV.
// Lee https://www.unav.edu/web/capellania/oratorios-y-misas y devuelve en JSON las misas
// de cada campus: [{ city, t, days, label, building, note }]. days: 0 = domingo … 6 = sábado;
// note: { día: "en inglés" }. La página tiene una tabla grande por campus (fila = hora,
// columnas = lunes…domingo) y, además, tablas pequeñas para el móvil, que se ignoran.
// Además lee las misas de la Clínica (CUN) en Pamplona y Madrid, de cun.es.
// Cada fuente va por su lado: la que falle sale como null (y la app usa su copia a mano),
// con la última copia buena en memoria (hasta 24 h). Solo da 502 si fallan todas.
// Si una lectura no tiene buena pinta (pocas misas), se da por fallida.
const TARGET = "https://www.unav.edu/web/capellania/oratorios-y-misas";
const STALE_MAX_S = 24 * 3600;
const HEADERS = { "User-Agent": "Mozilla/5.0", "Accept": "text/html", "Accept-Language": "es-ES,es;q=0.9" };

const CUN = {
  pamplona: { url: "https://www.cun.es/servicios-pacientes-familiares", building: "CUN", label: "CUN" },
  madrid: { url: "https://www.cun.es/servicios-pacientes-familiares-madrid", building: "CUN Madrid", label: "CUN Madrid" },
};
const lastGood = {}; // fuente -> { t, data }

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

// Página de la CUN: bloque «Misas» con renglones «Días laborables: 7:25, 8:00, 13:30, 19:00*»,
// «Sábados, domingos y festivos: …», «Sábados: …», «Domingos y festivos: …» y notas con «*».
function parseCun(html, city) {
  const i = html.search(/<strong>\s*Misas\s*<\/strong>/i);
  if (i < 0) return [];
  const block = html.slice(i, html.indexOf("</section>", i) > 0 ? html.indexOf("</section>", i) : i + 3000);
  const text = decode(block.replace(/<br\s*\/?>/gi, " | ").replace(/<\/p>/gi, " || "));
  // nota del asterisco
  const fm = text.match(/\*\s*([^|*]*verano[^|*]*)/i);
  let star = null;
  if (fm) {
    const h = fm[1].match(/a las (\d{1,2})(?:[:.](\d{2}))?\s*h/i);
    star = h ? "en verano, a las " + h[1] + ":" + (h[2] || "00") : fm[1].trim();
  }
  const out = {};
  const re = /(d[ií]as laborables|s[aá]bados(?:,\s*domingos)?(?:\s*y\s*festivos)?|domingos(?:\s*y\s*festivos)?)\s*:[\s|]*([0-9:.,\s*y]+)/gi;
  let m;
  while ((m = re.exec(text))) {
    const lab = norm(m[1]);
    const days = lab.startsWith("dias laborables") ? [1, 2, 3, 4, 5] : [
      ...(lab.includes("sabados") ? [6] : []), ...(lab.includes("domingos") ? [0] : [])];
    for (const tm of m[2].matchAll(/(\d{1,2})[:.](\d{2})(\*?)/g)) {
      const t = Number(tm[1]) + ":" + tm[2];
      const e = out[t] || (out[t] = { city, t, days: [], label: CUN[city].label, building: CUN[city].building, note: {} });
      days.forEach((d) => { if (!e.days.includes(d)) e.days.push(d); if (tm[3] && star) e.note[d] = star; });
    }
  }
  return Object.values(out).map((e) => (Object.keys(e.note).length ? e : (delete e.note, e)));
}

async function getHtml(url = TARGET) {
  let err = "";
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) {
      err = String((e && e.message) || e);
    }
  }
  throw new Error(url + ": " + err);
}

// Lee una fuente; si falla o no tiene buena pinta, la última buena (hasta 24 h) o null.
async function source(key, read, min) {
  try {
    const data = await read();
    if (data.length < min) throw new Error("pocas misas (" + data.length + ")");
    lastGood[key] = { t: Date.now(), data };
    return { data, error: null };
  } catch (e) {
    const g = lastGood[key];
    if (g && Date.now() - g.t <= STALE_MAX_S * 1000) return { data: g.data, error: "copia de hace " + Math.round((Date.now() - g.t) / 60000) + " min" };
    return { data: null, error: String(e.message || e) };
  }
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
  const [cap, cunP, cunM] = await Promise.all([
    source("capellania", async () => {
      const m = parse(await getHtml());
      if (m.filter((x) => x.city === "pamplona").length < 5) throw new Error("la tabla no tiene buena pinta (" + m.length + " misas)");
      return m;
    }, 1),
    source("cun-pamplona", async () => parseCun(await getHtml(CUN.pamplona.url), "pamplona"), 3),
    source("cun-madrid", async () => parseCun(await getHtml(CUN.madrid.url), "madrid"), 2),
  ]);
  if (!cap.data && !cunP.data && !cunM.data) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(502).send("No se pudo leer ningún horario de misas (" + [cap.error, cunP.error, cunM.error].join("; ") + ")");
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify({
    t: Date.now(), source: TARGET,
    misas: cap.data,                                   // Capellanía (null si falla)
    cun: { pamplona: cunP.data, madrid: cunM.data },   // CUN (null la que falle)
    errores: { capellania: cap.error, cunPamplona: cunP.error, cunMadrid: cunM.error },
  }));
}

module.exports = handler;
module.exports.parse = parse; // para las pruebas
module.exports.parseCun = parseCun;
