import { db, finishRun, startRun } from "../../db";
import { fetchAndSnapshot } from "../raw";

const ENDPOINT = "https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx";
const FREQUENCIES = ["DAILY", "MONTHLY", "QUARTERLY", "ANNUAL"] as const;

type Frequency = typeof FREQUENCIES[number];
type SeriesInfo = {
  seriesId: string;
  frequency?: string;
  frequencyCode?: string;
  spanishTitle?: string;
  englishTitle?: string;
  firstObservation?: string;
  lastObservation?: string;
  updatedAt?: string;
  createdAt?: string;
  [key: string]: unknown;
};

type Observation = {
  indexDateString?: string;
  value?: string | number;
  statusCode?: string;
  [key: string]: unknown;
};

type BcchResponse = {
  Codigo?: number | string;
  Descripcion?: string;
  Series?: {
    seriesId?: string;
    descripEsp?: string;
    descripIng?: string;
    Obs?: Observation[] | Observation | null;
  } | null;
  SeriesInfos?: SeriesInfo[] | SeriesInfo | null;
};

function asArray<T>(value:T[] | T | null | undefined):T[]{
  if(value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function apiUrl(token:string, params:Record<string,string>){
  const url = new URL(ENDPOINT);
  url.searchParams.set("token", token);
  for(const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
  return url.toString();
}

function apiError(payload:BcchResponse, context:string){
  const code = Number(payload.Codigo ?? 0);
  if(code !== 0) throw new Error(`${context}: BCCh ${code}: ${payload.Descripcion ?? "error desconocido"}`);
}

function toIsoDate(value:string | undefined){
  if(!value) return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if(match) return `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0,10);
}

function nextDay(value:string){
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate()+1);
  return date.toISOString().slice(0,10);
}

function safeNumber(value:unknown){
  if(value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function discoverFrequency(token:string, runId:number, frequency:Frequency){
  const url = apiUrl(token,{ function:"SearchSeries", frequency });
  const raw = await fetchAndSnapshot("bcentral",runId,url);
  const payload = JSON.parse(raw.text) as BcchResponse;
  apiError(payload,`SearchSeries ${frequency}`);
  return asArray(payload.SeriesInfos).filter((item)=>item?.seriesId);
}

function upsertSeriesCatalog(series:SeriesInfo){
  db.prepare(`
    INSERT INTO source_catalog_items(source_id,external_id,title,description,publisher,page_url,metadata_json,updated_at)
    VALUES('bcentral',?,?,?,?,?,?,?)
    ON CONFLICT(source_id,external_id) DO UPDATE SET
      title=excluded.title,
      description=excluded.description,
      publisher=excluded.publisher,
      page_url=excluded.page_url,
      metadata_json=excluded.metadata_json,
      updated_at=excluded.updated_at
  `).run(
    series.seriesId,
    series.spanishTitle || series.englishTitle || series.seriesId,
    series.englishTitle || null,
    "Banco Central de Chile",
    "https://si3.bcentral.cl/Siete/ES/Siete",
    JSON.stringify(series),
    toIsoDate(series.updatedAt) || series.updatedAt || null,
  );
}

async function fetchSeries(token:string, runId:number, series:SeriesInfo){
  const latest = db.prepare(`
    SELECT MAX(observed_at) AS latest
    FROM observations
    WHERE source_id='bcentral' AND metric=?
  `).get(series.seriesId) as {latest:string|null} | null;

  const firstAvailable = toIsoDate(series.firstObservation) ?? "1900-01-01";
  const lastAvailable = toIsoDate(series.lastObservation) ?? new Date().toISOString().slice(0,10);
  const firstDate = latest?.latest ? nextDay(latest.latest.slice(0,10)) : firstAvailable;
  if(firstDate > lastAvailable) return {seen:0,written:0,skipped:true};

  const url = apiUrl(token,{
    function:"GetSeries",
    timeseries:series.seriesId,
    firstdate:firstDate,
    lastdate:lastAvailable,
  });
  const raw = await fetchAndSnapshot("bcentral",runId,url);
  const payload = JSON.parse(raw.text) as BcchResponse;
  apiError(payload,`GetSeries ${series.seriesId}`);
  const observations = asArray(payload.Series?.Obs);

  let written = 0;
  const stmt = db.prepare(`
    INSERT INTO observations(
      source_id,external_id,observed_at,metric,value_number,value_text,unit,
      subject_type,subject_id,raw_snapshot_id,payload_json
    ) VALUES('bcentral',?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_id,external_id,metric) DO UPDATE SET
      observed_at=excluded.observed_at,
      value_number=excluded.value_number,
      value_text=excluded.value_text,
      raw_snapshot_id=excluded.raw_snapshot_id,
      payload_json=excluded.payload_json
  `);

  const tx = db.transaction(()=>{
    for(const observation of observations){
      const observedAt = toIsoDate(observation.indexDateString);
      if(!observedAt) continue;
      const valueNumber = safeNumber(observation.value);
      const valueText = valueNumber == null && observation.value != null ? String(observation.value) : null;
      const externalId = `${series.seriesId}:${observedAt}`;
      stmt.run(
        externalId,
        observedAt,
        series.seriesId,
        valueNumber,
        valueText,
        null,
        "statistical_series",
        series.seriesId,
        raw.snapshotId,
        JSON.stringify({series,observation}),
      );
      written++;
    }
  });
  tx();
  return {seen:observations.length,written,skipped:false};
}

async function mapConcurrent<T>(items:T[], concurrency:number, worker:(item:T,index:number)=>Promise<void>){
  let cursor = 0;
  const runners = Array.from({length:Math.max(1,concurrency)}, async()=>{
    while(true){
      const index = cursor++;
      if(index >= items.length) return;
      await worker(items[index],index);
    }
  });
  await Promise.all(runners);
}

export async function syncBCentral(){
  const token = process.env.BCCH_API_KEY?.trim();
  if(!token) throw new Error("Falta BCCH_API_KEY en .env");

  const run = startRun("bcentral");
  let seen = 0;
  let written = 0;
  try{
    const cfgFile = Bun.file("data/bcentral-series.json");
    let configuredIds:string[] = [];
    if(await cfgFile.exists()){
      try {
        const cfg = await cfgFile.json() as {series?:Array<{id:string}|string>};
        configuredIds = (cfg.series ?? []).map((entry)=>typeof entry === "string" ? entry : entry.id).filter(Boolean);
      } catch {
        // Un archivo inválido no debe impedir autodiscovery; se regenerará abajo.
      }
    }

    const discovered:SeriesInfo[] = [];
    for(const frequency of FREQUENCIES){
      const series = await discoverFrequency(token,run,frequency);
      discovered.push(...series);
      console.log(`[bcentral] ${frequency}: ${series.length} series descubiertas`);
    }

    const unique = new Map<string,SeriesInfo>();
    for(const series of discovered) unique.set(series.seriesId,series);
    for(const series of unique.values()) upsertSeriesCatalog(series);

    const selected = configuredIds.length
      ? configuredIds.map((id)=>unique.get(id)).filter((item):item is SeriesInfo=>Boolean(item))
      : [...unique.values()];

    await Bun.write("data/bcentral-series.json",JSON.stringify({
      mode: configuredIds.length ? "configured" : "auto",
      discoveredAt:new Date().toISOString(),
      frequencies:FREQUENCIES,
      series:selected.map((series)=>({
        id:series.seriesId,
        name:series.spanishTitle || series.englishTitle || series.seriesId,
        frequency:series.frequencyCode || series.frequency,
        firstObservation:series.firstObservation,
        lastObservation:series.lastObservation,
      })),
    },null,2)+"\n");

    console.log(`[bcentral] sincronizando ${selected.length} series`);
    const concurrency = Math.max(1,Number(process.env.BCCH_CONCURRENCY ?? "2") || 2);
    let completed = 0;
    let failed = 0;
    const errors:string[] = [];

    await mapConcurrent(selected,concurrency,async(series)=>{
      try{
        const result = await fetchSeries(token,run,series);
        seen += result.seen;
        written += result.written;
      }catch(error){
        failed++;
        const message = `${series.seriesId}: ${String(error)}`;
        errors.push(message);
        console.error(`[bcentral] ${message}`);
      }finally{
        completed++;
        if(completed % 25 === 0 || completed === selected.length){
          console.log(`[bcentral] ${completed}/${selected.length} series · obs=${seen} written=${written} failed=${failed}`);
        }
      }
    });

    const message = `series=${selected.length}; failed=${failed}${errors.length ? `; firstErrors=${errors.slice(0,5).join(" | ")}` : ""}`;
    finishRun(run,failed === selected.length && selected.length > 0 ? "failed" : "success",message,seen,written);
    return {series:selected.length,seen,written,failed,concurrency};
  }catch(error){
    finishRun(run,"failed",String(error),seen,written);
    throw error;
  }
}
