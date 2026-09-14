import { initDb, db } from "../db";
import { SOURCES } from "../domain/sources";

await initDb();
const port = Number(process.env.PORT ?? 3000);

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const num = (q: string, ...p: any[]) => Number((db.query(q).get(...p) as any)?.n ?? 0);
const rows = (q: string, ...p: any[]) => db.query(q).all(...p) as any[];

type CacheEntry = { at: number; value: unknown };
const cache = new Map<string, CacheEntry>();
function cached<T>(key: string, ttl: number, build: () => T): T {
  const now = Date.now(), hit = cache.get(key);
  if (hit && now - hit.at < ttl) return hit.value as T;
  const value = build();
  cache.set(key, { at: now, value });
  return value;
}

function normalizeText(v: string) {
  return v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

type IndicatorSpec = { key: string; label: string; patterns: string[] };
type MetricDef = { external_id: string; title: string; unit: string | null; frequency: string | null; geo_scope: string | null };

function metricDefinitions(sourceId: string): MetricDef[] {
  return rows(`SELECT external_id,title,unit,frequency,geo_scope FROM metric_definitions WHERE source_id=? ORDER BY title`, sourceId);
}

function pickMetricFrom(defs: MetricDef[], spec: IndicatorSpec): MetricDef | null {
  for (const pattern of spec.patterns) {
    const p = normalizeText(pattern);
    const candidates = defs.filter(d => normalizeText(d.title).includes(p));
    candidates.sort((a, b) => normalizeText(a.title).length - normalizeText(b.title).length);
    if (candidates[0]) return candidates[0];
  }
  return null;
}

function latestNumeric(sourceId: string, metric: MetricDef) {
  return db.query(`
    SELECT o.observed_at,o.value_number,o.unit,g.name geo_name,g.geo_type
    FROM observations o
    LEFT JOIN geo_areas g ON g.id=o.geo_area_id
    WHERE o.source_id=? AND o.metric=? AND o.value_number IS NOT NULL
    ORDER BY o.observed_at DESC,
      CASE g.geo_type WHEN 'country' THEN 0 WHEN 'region' THEN 1 WHEN 'commune' THEN 2 ELSE 3 END,
      o.id DESC
    LIMIT 1
  `).get(sourceId, metric.external_id) as any ?? null;
}

function featuredIndicators(sourceId: string, specs: IndicatorSpec[]) {
  const defs = metricDefinitions(sourceId), out: any[] = [], used = new Set<string>();
  for (const spec of specs) {
    const metric = pickMetricFrom(defs, spec);
    if (!metric || used.has(metric.external_id)) continue;
    const obs = latestNumeric(sourceId, metric);
    if (!obs) continue;
    used.add(metric.external_id);
    out.push({
      key: spec.key,
      label: spec.label,
      title: metric.title,
      metric: metric.external_id,
      value: obs.value_number,
      unit: metric.unit ?? obs.unit,
      date: obs.observed_at,
      territory: obs.geo_name,
      geoScope: metric.geo_scope,
      sourceId,
    });
  }
  return out;
}

const ECONOMIC_SPECS: IndicatorSpec[] = [
  { key: "uf", label: "Unidad de Fomento (UF)", patterns: ["unidad de fomento"] },
  { key: "utm", label: "Unidad Tributaria Mensual (UTM)", patterns: ["unidad tributaria mensual"] },
  { key: "ipc", label: "IPC", patterns: ["indice de precios al consumidor", "ndice de precios al consumidor", "ipc general"] },
  { key: "usd", label: "Dólar observado", patterns: ["dolar observado", "d lar observado"] },
  { key: "tpm", label: "Tasa de Política Monetaria", patterns: ["tasa de politica monetaria", "tasa de pol tica monetaria", "politica monetaria"] },
  { key: "imacec", label: "IMACEC", patterns: ["imacec"] },
];
const ENERGY_SPECS: IndicatorSpec[] = [
  { key: "capacity", label: "Capacidad instalada", patterns: ["capacidad instalada"] },
  { key: "generation", label: "Generación eléctrica", patterns: ["generacion bruta", "generacion electrica"] },
  { key: "distributed", label: "Generación distribuida", patterns: ["generacion distribuida"] },
  { key: "emissions", label: "Factor de emisión", patterns: ["factor de emision"] },
];
const SINIM_SPECS: IndicatorSpec[] = [
  { key: "population", label: "Población comunal", patterns: ["poblacion comunal", "poblacion total", "poblacion"] },
  { key: "income", label: "Ingresos municipales", patterns: ["ingresos municipales", "ingresos"] },
  { key: "spending", label: "Gastos municipales", patterns: ["gastos municipales", "gastos"] },
  { key: "fcm", label: "Fondo Común Municipal", patterns: ["fondo comun municipal"] },
  { key: "area", label: "Superficie comunal", patterns: ["superficie comunal"] },
];
const LABOR_SPECS: IndicatorSpec[] = [
  { key: "unemployment", label: "Tasa de desocupación", patterns: ["tasa de desocupacion", "desocupacion"] },
  { key: "employment", label: "Personas ocupadas", patterns: ["personas ocupadas", "ocupados"] },
  { key: "labor_force", label: "Fuerza de trabajo", patterns: ["fuerza de trabajo"] },
  { key: "participation", label: "Tasa de participación", patterns: ["tasa de participacion"] },
];

function economySummary() {
  return { source: "Banco Central de Chile", indicators: featuredIndicators("bcentral", ECONOMIC_SPECS) };
}

function chileCompraSummary() {
  return {
    source: "ChileCompra / Mercado Público",
    orders: num(`SELECT count(*) n FROM transactions WHERE source_id='chilecompra'`),
    amount: Number((db.query(`SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE source_id='chilecompra'`).get() as any)?.n ?? 0),
    buyers: num(`SELECT count(DISTINCT tp.organization_id) n FROM transaction_parties tp JOIN transactions t ON t.id=tp.transaction_id WHERE t.source_id='chilecompra' AND tp.role='buyer'`),
    suppliers: num(`SELECT count(DISTINCT tp.organization_id) n FROM transaction_parties tp JOIN transactions t ON t.id=tp.transaction_id WHERE t.source_id='chilecompra' AND tp.role='supplier'`),
    byRegion: rows(`SELECT g.name region,count(*) orders,COALESCE(sum(t.amount),0) amount FROM transactions t JOIN geo_areas g ON g.id=t.geo_area_id WHERE t.source_id='chilecompra' GROUP BY g.id,g.name ORDER BY amount DESC LIMIT 8`),
    latestDate: (db.query(`SELECT max(occurred_at) d FROM transactions WHERE source_id='chilecompra'`).get() as any)?.d ?? null,
  };
}

function municipalSummary() {
  return {
    source: "SINIM / SUBDERE",
    communes: num(`SELECT count(*) n FROM geo_areas WHERE source_id='sinim' AND geo_type='commune'`),
    mayors: num(`SELECT count(*) n FROM relationships WHERE source_id='sinim' AND relation_type='mayor'`),
    councillors: num(`SELECT count(*) n FROM relationships WHERE source_id='sinim' AND relation_type='councillor'`),
    period: (db.query(`SELECT max(observed_at) d FROM observations WHERE source_id='sinim'`).get() as any)?.d ?? null,
    indicators: featuredIndicators("sinim", SINIM_SPECS),
  };
}

function laborSummary() {
  return {
    source: "Instituto Nacional de Estadísticas (INE)",
    period: (db.query(`SELECT max(observed_at) d FROM observations WHERE source_id='ine'`).get() as any)?.d ?? null,
    indicators: featuredIndicators("ine", LABOR_SPECS),
  };
}

function energySummary() {
  return {
    source: "Comisión Nacional de Energía (CNE)",
    period: (db.query(`SELECT max(observed_at) d FROM observations WHERE source_id='energia-abierta'`).get() as any)?.d ?? null,
    indicators: featuredIndicators("energia-abierta", ENERGY_SPECS),
  };
}

function headlineCards(economy: any, purchases: any, municipal: any) {
  const byKey = new Map((economy.indicators ?? []).map((x: any) => [x.key, x]));
  const card = (key: string, fallbackLabel: string) => {
    const x: any = byKey.get(key);
    return x ? { label: x.label, value: x.value, unit: x.unit, date: x.date, source: economy.source } : { label: fallbackLabel, value: null };
  };
  return [
    card("uf", "Unidad de Fomento"),
    card("usd", "Dólar observado"),
    card("ipc", "IPC"),
    { label: "Compras públicas registradas", value: purchases.amount, unit: "CLP", date: purchases.latestDate, source: purchases.source, format: "money" },
    { label: "Comunas", value: municipal.communes, unit: "comunas", date: municipal.period, source: municipal.source, format: "integer" },
  ];
}

function dashboardPayload() {
  const economy = economySummary(), purchases = chileCompraSummary(), municipal = municipalSummary(), labor = laborSummary(), energy = energySummary();
  return { generatedAt: new Date().toISOString(), headline: headlineCards(economy, purchases, municipal), economy, purchases, municipal, labor, energy };
}

function latestRun(sourceId: string) {
  return db.query(`SELECT id,source_id,started_at,finished_at,status,message,records_seen,records_written FROM ingest_runs WHERE source_id=? ORDER BY id DESC LIMIT 1`).get(sourceId) as any ?? null;
}

function connectorProgress() {
  const resourceCounts = Object.fromEntries(rows(`SELECT sync_status,count(*) n FROM source_resources GROUP BY sync_status`).map(r => [r.sync_status, Number(r.n)]));
  const total = Object.values(resourceCounts).reduce((a: number, b: any) => a + Number(b || 0), 0);
  const done = Number(resourceCounts.parsed || 0) + Number(resourceCounts.downloaded || 0) + Number(resourceCounts.unsupported || 0);
  const b = latestRun("bcentral"), d = latestRun("datos-gob"), c = latestRun("chilecompra"), e = latestRun("energia-abierta"), s = latestRun("sinim"), i = latestRun("ine");
  const metrics = num(`SELECT count(*) n FROM metric_definitions WHERE source_id='bcentral'`), match = b?.message?.match(/^(\d+)\/(\d+)/);
  const shapes = num(`SELECT count(*) n FROM geo_areas WHERE source_id='ide-chile' AND geometry_json IS NOT NULL`), areas = num(`SELECT count(*) n FROM geo_areas WHERE source_id='ide-chile' AND geo_type='region'`);
  return [
    { id: "datos-gob", name: "Datos.gob.cl", current: done, total, unit: "recursos", run: d },
    { id: "bcentral", name: "Banco Central", current: match ? Number(match[1]) : (b?.status === "success" ? metrics : 0), total: match ? Number(match[2]) : metrics, unit: "series", run: b },
    { id: "chilecompra", name: "ChileCompra", current: num(`SELECT count(*) n FROM transactions WHERE source_id='chilecompra'`), total: null, unit: "órdenes", run: c },
    { id: "energia-abierta", name: "Energía Abierta", current: e?.records_written ?? 0, total: null, unit: "registros", run: e },
    { id: "sinim", name: "SINIM", current: s?.records_written ?? 0, total: null, unit: "registros", run: s },
    { id: "ine", name: "INE", current: i?.records_written ?? 0, total: null, unit: "registros", run: i },
    { id: "ide-chile", name: "Geografía", current: shapes, total: areas, unit: "regiones", run: null },
  ];
}

function progressPayload() {
  return {
    generatedAt: new Date().toISOString(),
    connectorProgress: connectorProgress(),
    recentRuns: rows(`SELECT id,source_id,started_at,finished_at,status,message,records_seen,records_written FROM ingest_runs ORDER BY id DESC LIMIT 12`),
    activeRuns: rows(`SELECT id,source_id,started_at,status,message,records_seen,records_written FROM ingest_runs WHERE status='running' ORDER BY id DESC LIMIT 12`),
  };
}

function directRegionalValues(sourceId: string, metricId: string) {
  return rows(`
    WITH ranked AS (
      SELECT g.id region_id,o.value_number,o.observed_at,
             ROW_NUMBER() OVER(PARTITION BY g.id ORDER BY o.observed_at DESC,o.id DESC) rn
      FROM observations o
      JOIN geo_areas g ON g.id=o.geo_area_id
      WHERE o.source_id=? AND o.metric=? AND o.value_number IS NOT NULL AND g.geo_type='region'
    )
    SELECT region_id,value_number value,observed_at date FROM ranked WHERE rn=1
  `, sourceId, metricId);
}

function municipalPopulationByRegion(metricId: string) {
  return rows(`
    WITH latest AS (SELECT max(observed_at) d FROM observations WHERE source_id='sinim' AND metric=?),
    values_by_region AS (
      SELECT p.id region_id,SUM(o.value_number) value,COUNT(*) communes
      FROM observations o
      JOIN geo_areas c ON c.id=o.geo_area_id AND c.geo_type='commune'
      JOIN geo_areas p ON p.id=c.parent_id AND p.geo_type='region'
      WHERE o.source_id='sinim' AND o.metric=? AND o.value_number IS NOT NULL AND o.observed_at=(SELECT d FROM latest)
      GROUP BY p.id
    )
    SELECT region_id,value,communes,(SELECT d FROM latest) date FROM values_by_region
  `, metricId, metricId);
}

function mapPayload() {
  const purchaseRows = rows(`SELECT g.id region_id,COUNT(t.id) orders,COALESCE(SUM(t.amount),0) value FROM geo_areas g LEFT JOIN transactions t ON t.geo_area_id=g.id AND t.source_id='chilecompra' WHERE g.source_id='ide-chile' AND g.geo_type='region' GROUP BY g.id`);
  const purchases = new Map(purchaseRows.map(r => [r.region_id, r]));

  const sinimDefs = metricDefinitions("sinim"), ineDefs = metricDefinitions("ine"), energyDefs = metricDefinitions("energia-abierta");
  const municipalMetric = pickMetricFrom(sinimDefs, SINIM_SPECS[0]);
  const laborMetric = pickMetricFrom(ineDefs, LABOR_SPECS[0]);
  const energyMetric = pickMetricFrom(energyDefs, ENERGY_SPECS[0]) ?? pickMetricFrom(energyDefs, ENERGY_SPECS[1]);

  const municipalRows = municipalMetric ? municipalPopulationByRegion(municipalMetric.external_id) : [];
  const laborRows = laborMetric ? directRegionalValues("ine", laborMetric.external_id) : [];
  const energyRows = energyMetric ? directRegionalValues("energia-abierta", energyMetric.external_id) : [];
  const municipalValues = new Map(municipalRows.map(r => [r.region_id, r])), laborValues = new Map(laborRows.map(r => [r.region_id, r])), energyValues = new Map(energyRows.map(r => [r.region_id, r]));

  const layers: any[] = [
    { id: "geography", label: "Geografía oficial", source: "IDE Chile", unit: null, scale: "none" },
    { id: "purchases", label: "Compras públicas — monto", source: "ChileCompra", unit: "CLP", scale: "log", countLabel: "órdenes" },
  ];
  if (municipalMetric && municipalRows.length) layers.push({ id: "municipal", label: municipalMetric.title, source: "SINIM / SUBDERE", unit: municipalMetric.unit, scale: "log", countLabel: "comunas" });
  if (laborMetric && laborRows.length) layers.push({ id: "labor", label: laborMetric.title, source: "INE", unit: laborMetric.unit, scale: "linear" });
  if (energyMetric && energyRows.length) layers.push({ id: "energy", label: energyMetric.title, source: "CNE", unit: energyMetric.unit, scale: "log" });

  const areas = rows(`SELECT id,code,name,geometry_json FROM geo_areas WHERE source_id='ide-chile' AND geo_type='region' AND geometry_json IS NOT NULL`);
  return {
    type: "FeatureCollection",
    layers,
    features: areas.map(r => {
      const p: any = purchases.get(r.id), m: any = municipalValues.get(r.id), l: any = laborValues.get(r.id), e: any = energyValues.get(r.id);
      return {
        type: "Feature",
        geometry: JSON.parse(r.geometry_json),
        properties: {
          kind: "area", id: r.id, code: r.code, label: r.name,
          values: {
            purchases: p ? { value: Number(p.value || 0), count: Number(p.orders || 0), date: null } : null,
            municipal: m ? { value: Number(m.value), count: Number(m.communes || 0), date: m.date } : null,
            labor: l ? { value: Number(l.value), date: l.date } : null,
            energy: e ? { value: Number(e.value), date: e.date } : null,
          },
        },
      };
    }),
  };
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") return json({ ok: true, time: new Date().toISOString() });
    if (url.pathname === "/api/sources") return json(SOURCES);
    if (url.pathname === "/api/dashboard") return json(cached("dashboard", 300000, dashboardPayload));
    if (url.pathname === "/api/progress") return json(progressPayload());
    if (url.pathname === "/api/map/features") return json(cached("map", 300000, mapPayload));
    if (url.pathname === "/api/transactions") {
      const source = url.searchParams.get("source"), limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 1000);
      return source ? json(rows(`SELECT * FROM transactions WHERE source_id=? ORDER BY occurred_at DESC,id DESC LIMIT ?`, source, limit)) : json(rows(`SELECT * FROM transactions ORDER BY occurred_at DESC,id DESC LIMIT ?`, limit));
    }
    if (url.pathname === "/api/observations") {
      const source = url.searchParams.get("source"), metric = url.searchParams.get("metric"), from = url.searchParams.get("from"), to = url.searchParams.get("to"), limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 5000), clauses: string[] = [], params: any[] = [];
      if (source) { clauses.push("o.source_id=?"); params.push(source); }
      if (metric) { clauses.push("o.metric=?"); params.push(metric); }
      if (from) { clauses.push("o.observed_at>=?"); params.push(from); }
      if (to) { clauses.push("o.observed_at<=?"); params.push(to); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return json(rows(`SELECT o.id,o.source_id,o.external_id,o.observed_at,o.metric,COALESCE(m.title,o.metric) metric_title,o.value_number,o.value_text,COALESCE(m.unit,o.unit) unit,o.geo_area_id FROM observations o LEFT JOIN metric_definitions m ON m.source_id=o.source_id AND m.external_id=o.metric ${where} ORDER BY o.observed_at DESC,o.id DESC LIMIT ?`, ...params, limit));
    }
    if (url.pathname === "/api/metrics") {
      const source = url.searchParams.get("source"), limit = Math.min(Number(url.searchParams.get("limit") ?? 500), 5000);
      return source ? json(rows(`SELECT external_id metric,title,frequency,geo_scope,unit FROM metric_definitions WHERE source_id=? ORDER BY title LIMIT ?`, source, limit)) : json(rows(`SELECT * FROM metric_definitions ORDER BY source_id,title LIMIT ?`, limit));
    }
    if (url.pathname === "/api/geo/areas") return json(cached("areas", 300000, () => rows(`SELECT id,geo_type,code,name,parent_id,centroid_lat,centroid_lon,geometry_json FROM geo_areas ORDER BY geo_type,name LIMIT 10000`)));
    if (url.pathname === "/api/runs") return json(rows(`SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 100`));

    const path = url.pathname === "/" ? "public/index.html" : `public${url.pathname}`;
    const file = Bun.file(path);
    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Chile Transparente: http://localhost:${server.port}`);
