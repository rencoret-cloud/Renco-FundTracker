/**
 * Renco FundTracker — data update script (CMF edition)
 * -----------------------------------------------------------------------
 * Lee los archivos TXT descargados manualmente de la Cartola Diaria de la
 * CMF (https://www.cmfchile.cl/institucional/estadisticas/fondos_cartola_diaria.php)
 * y los fusiona en data/funds.json que lee la app.
 *
 * OPERACIÓN MANUAL (mientras implementamos Playwright):
 *   1. Entra al formulario de la CMF.
 *   2. Descarga un .txt por cada código de fondo que aparece en CMF_SOURCES.
 *      Fecha inicio: 01/01/2023 · Fecha término: hoy.
 *   3. Sube los .txt a la carpeta data/cmf/ del repo.
 *   4. Corre este script (manualmente desde Actions o espera el cron).
 *
 * El script es acumulativo: si ya tienes datos hasta junio, la próxima vez
 * solo subes el archivo del mes que falta y fusiona sin duplicados.
 * -----------------------------------------------------------------------
 */
import { writeFile, readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH   = path.join(__dirname, "../data/funds.json");
const CMF_DIR     = path.join(__dirname, "../data/cmf");

// Mapeo fondo-app → código CMF + serie exacta
// RUN_FM es el número en el selector del formulario CMF.
// SERIE debe coincidir exactamente con la columna SERIE del archivo.
const CMF_SOURCES = [
  // LarrainVial
  { id: "lv-agresiva",          runFm: "10002", serie: "A"     },
  { id: "lv-agresiva-q",        runFm: "9193",  serie: "Q"     },
  { id: "lv-moderada",          runFm: "9816",  serie: "A"     },
  { id: "lv-conservadora",      runFm: "9853",  serie: "A"     },
  { id: "lv-conservadora-q",    runFm: "9192",  serie: "Q"     },
  { id: "lv-ahorro-capital-a",  runFm: "8263",  serie: "A"     },
  { id: "lv-ahorro-capital-f",  runFm: "8263",  serie: "F"     },
  // Banchile
  { id: "banchile-horizonte",   runFm: "8023",  serie: "L"     },
  // Itaú
  { id: "itau-dinamico",              runFm: "8959", serie: "A" },
  { id: "itau-gestionado-agresivo-f1",runFm: "8925", serie: "A" },
  // Santander
  { id: "santander-pb-agresivo",      runFm: "8908", serie: "GLOBAL" },
  { id: "santander-go-ejecutiva",     runFm: "8090", serie: "EJECU"  },
  { id: "santander-go-inversionista", runFm: "8090", serie: "INVER"  },
  { id: "santander-renta-largo-plazo",runFm: "8082", serie: "UNIVE"  },
];

// Fondos sin fuente pública disponible (quedan en datos de muestra)
const MANUAL_ONLY = [
  "bfg-global-dynamic",
  "jpm-global-income",
  "bfg-fixed-income-global-a",
  "bfg-fixed-income-global-c",
  "itau-gestionado-moderado-f3",
  "itau-gestionado-moderado-f1",
  "itau-gestionado-conservador-f1",
  "itau-gestionado-agresivo-f2",
  "itau-gestionado-conservador-f2",
];

// ---------------------------------------------------------------------------
// Parser del formato CMF
// Columnas (0-indexed): 2=RUN_FM, 3=FECHA, 8=SERIE, 12=VALOR_CUOTA
// ---------------------------------------------------------------------------
function parseCmfFile(text, runFm, serie) {
  const lines = text.split(/\r?\n/);
  const series = [];
  for (const line of lines) {
    const cols = line.split(";");
    if (cols.length < 13) continue;
    if (cols[2].trim() !== String(runFm)) continue;
    if (cols[8].trim().toUpperCase() !== serie.toUpperCase()) continue;
    const rawDate = cols[3].trim(); // YYYYMMDD
    if (!/^\d{8}$/.test(rawDate)) continue;
    const date = `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`;
    const value = parseFloat(cols[12].replace(",", "."));
    if (!isFinite(value) || value <= 0) continue;
    series.push({ date, value });
  }
  return series;
}

// Encuentra el archivo CMF más reciente para un fondo dado
// Acepta cualquier txt que contenga el runFm en el nombre o en el contenido
async function findCmfFiles(runFm) {
  if (!existsSync(CMF_DIR)) return [];
  const files = await readdir(CMF_DIR);
  // Primero intenta coincidencia por nombre (ffmm_RUNFM_*.txt)
  const byName = files.filter(f => f.startsWith(`ffmm_${runFm}_`) && f.endsWith(".txt"));
  if (byName.length) return byName.map(f => path.join(CMF_DIR, f));
  // Si no, devuelve todos los .txt (el parser filtra por RUN_FM internamente)
  return files.filter(f => f.endsWith(".txt")).map(f => path.join(CMF_DIR, f));
}

async function loadExisting() {
  try {
    return JSON.parse(await readFile(DATA_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function main() {
  // Verifica que exista la carpeta de archivos CMF
  if (!existsSync(CMF_DIR)) {
    console.warn("⚠ Carpeta data/cmf/ no encontrada. Crea la carpeta y sube los archivos TXT de la CMF.");
    process.exit(0);
  }

  const existing = await loadExisting();
  const out = { __generatedAt: new Date().toISOString() };

  for (const src of CMF_SOURCES) {
    try {
      const files = await findCmfFiles(src.runFm);
      if (!files.length) {
        console.warn(`⚠ ${src.id}: no se encontró archivo CMF para fondo ${src.runFm}. Conservando datos previos.`);
        if (existing[src.id]) out[src.id] = existing[src.id];
        continue;
      }

      // Lee y fusiona todos los archivos encontrados para este fondo
      let allPoints = {};
      for (const filePath of files) {
        const text = await readFile(filePath, "latin1");
        const pts  = parseCmfFile(text, src.runFm, src.serie);
        for (const p of pts) allPoints[p.date] = p;
      }

      // Fusiona con los datos anteriores (los nuevos pisan si hay conflicto de fecha)
      const prev = existing[src.id]?.series || [];
      for (const p of prev) {
        if (!allPoints[p.date]) allPoints[p.date] = p;
      }

      const series = Object.values(allPoints).sort((a,b) => a.date > b.date ? 1 : -1);

      out[src.id] = {
        series,
        lastUpdated: new Date().toISOString(),
        source: "cmf-cartola-diaria",
      };

      const last = series[series.length - 1];
      console.log(`✓ ${src.id}: ${series.length} puntos · último ${last?.date} = ${last?.value}`);
    } catch (err) {
      console.error(`✗ ${src.id}: ${err.message}`);
      if (existing[src.id]) out[src.id] = existing[src.id];
    }
  }

  // Conserva los fondos manuales sin tocar
  for (const id of MANUAL_ONLY) {
    if (existing[id]) out[id] = existing[id];
  }

  await writeFile(DATA_PATH, JSON.stringify(out, null, 2));
  console.log("\nListo: data/funds.json actualizado.");
}

main().catch(err => { console.error(err); process.exit(1); });
