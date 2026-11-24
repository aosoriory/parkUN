// Proxy en Vercel para los espacios de la UNAV (salas de estudio, cafeterías y meeting points).
// Los datos vienen de la API pública de Quodus (https://unav.quodus.ai/api/room-list), que no
// envía cabeceras CORS. Se devuelve una versión reducida en JSON, con CORS.
// Orden: Quodus directa (2 intentos) -> última copia buena en memoria (hasta 10 min, con X-Stale-Age)
// -> error 502 con el motivo.
const TARGET = "https://unav.quodus.ai/api/room-list";
const STALE_MAX_S = 10 * 60;
const HEADERS = { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Accept-Language": "es-ES,es;q=0.9" };

let last = null; // { t: ms, body }

const KIND_BY_TYPE = { 1: "salas", 2: "cafeterias", 3: "meeting" };

function campusOf(address) {
  const a = String(address || "").toLowerCase();
  if (a.includes("madrid")) return "madrid";
  if (a.includes("sebasti")) return "sansebastian";
  return "pamplona";
}

function slim(list) {
  const now = Date.now();
  return list
    .filter((r) => r && !r.disabled && KIND_BY_TYPE[r.type])
    .map((r) => ({
      id: r.id,
      kind: KIND_BY_TYPE[r.type],
      city: campusOf(r.address),
      building: r.buildingName || "",
      name: r.name || "",
      capacity: typeof r.capacity === "number" ? r.capacity : null,
      occupancy: typeof r.occupancy === "number" ? r.occupancy : null,
      percentage: typeof r.percentage === "number" ? r.percentage : null,
      isOpen: !!r.isOpen,
      hasSchedule: !!r.hasSchedule,
      lastUpdate: r.lastUpdate || null,
      // Solo los tramos que aún no han terminado (para saber hasta cuándo abre o cuándo abre).
      timetable: (r.timetable || [])
        .filter((s) => s && s.to > now)
        .slice(0, 4)
        .map((s) => ({ from: s.from, to: s.to, open: !!s.open })),
    }));
}

async function getList() {
  let err = "";
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(TARGET, { headers: HEADERS, signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (!Array.isArray(j) || !j.length) throw new Error("lista vacía");
      return j;
    } catch (e) {
      err = String((e && e.message) || e);
    }
  }
  throw new Error("quodus: " + err);
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
  try {
    const list = await getList();
    const body = JSON.stringify({ t: Date.now(), spaces: slim(list) });
    last = { t: Date.now(), body };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(body);
    return;
  } catch (e) {
    const age = last ? Math.round((Date.now() - last.t) / 1000) : null;
    if (last && age <= STALE_MAX_S) {
      res.setHeader("X-Stale-Age", String(age));
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.status(200).send(last.body);
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(502).send("Quodus no responde (" + e.message + ")");
  }
};
