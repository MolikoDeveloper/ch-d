import { db } from "../db";
import { syncOfficialRegions } from "../geo";
import { syncDatosGob } from "../ingest/connectors/datos-gob";
import { syncDatosGobResources } from "../ingest/connectors/datos-resources";
import { syncEnergiaAbierta } from "../ingest/connectors/energia-abierta";
import { syncSinim } from "../ingest/connectors/sinim";
import { syncRsh } from "../ingest/connectors/rsh";
import { syncCasen } from "../ingest/connectors/casen";
import { syncSii } from "../ingest/connectors/sii";
import { syncServel } from "../ingest/connectors/servel";
import { syncPresupuestoAbierto } from "../ingest/connectors/presupuesto-abierto";
import { syncIne } from "../ingest/connectors/ine";
import { syncBCentral } from "../ingest/connectors/bcentral";
import { syncChileCompra } from "../ingest/connectors/chilecompra";

type SyncResult={source:string;status:"ok"|"failed"|"skipped";detail:string};
type SyncAllOptions={concurrency:number;includeRaw:boolean;force:boolean;from?:string;to?:string};
type RunRow={status:string;finished_at:string|null;message:string|null};

const FRESHNESS_HOURS:Record<string,number>={
  "datos-gob":24,
  sinim:24,
  rsh:24,
  casen:24*7,
  ine:6,
  sii:24*7,
  servel:24,
  "presupuesto-abierto":6,
  "energia-abierta":6,
  bcentral:3,
  chilecompra:1,
};

function hoursLabel(hours:number){
  if(hours>=24&&hours%24===0)return`${hours/24}d`;
  return`${hours}h`;
}
function ageLabel(ms:number){
  const minutes=Math.max(0,Math.floor(ms/60000));
  if(minutes<60)return`${minutes} min`;
  const hours=Math.floor(minutes/60);
  if(hours<48)return`${hours} h`;
  return`${Math.floor(hours/24)} d`;
}
function ttl(sourceId:string){
  const envKey=`SYNC_TTL_${sourceId.toUpperCase().replace(/[^A-Z0-9]+/g,"_")}_HOURS`;
  const configured=Number(process.env[envKey]);
  return Number.isFinite(configured)&&configured>=0?configured:(FRESHNESS_HOURS[sourceId]??24);
}
function latestRun(sourceId:string,kind?:"datos-catalog"){
  const clause=kind==="datos-catalog"?`AND (message IS NULL OR message='catalog')`:"";
  return db.query(`SELECT status,finished_at,message FROM ingest_runs WHERE source_id=? ${clause} ORDER BY id DESC LIMIT 1`).get(sourceId) as RunRow|null;
}
function freshnessSkip(sourceId:string,options:SyncAllOptions,kind?:"datos-catalog"){
  if(options.force)return undefined;
  const maxAge=ttl(sourceId),run=latestRun(sourceId,kind);
  if(!run||run.status!=="success"||!run.finished_at)return undefined;
  const age=Date.now()-Date.parse(run.finished_at);
  if(!Number.isFinite(age)||age<0||age>=maxAge*3600000)return undefined;
  return`ya actualizado hace ${ageLabel(age)} · TTL ${hoursLabel(maxAge)}`;
}
function geographySkip(options:SyncAllOptions){
  if(options.force)return undefined;
  const regions=Number((db.query(`SELECT COUNT(*) n FROM geo_areas WHERE geo_type='region' AND geometry_json IS NOT NULL`).get()as any)?.n??0);
  const communes=Number((db.query(`SELECT COUNT(*) n FROM geo_areas WHERE geo_type='commune' AND geometry_json IS NOT NULL`).get()as any)?.n??0);
  if(regions>=16&&communes>=330)return`geometría ya cargada · regiones=${regions} comunas=${communes}`;
  return undefined;
}
function datosResourcesSkip(options:SyncAllOptions){
  if(options.force)return undefined;
  const n=Number((db.query(`SELECT COUNT(*) n FROM source_resources WHERE sync_status IN ('pending','failed')`).get()as any)?.n??0);
  return n===0?"sin recursos pending/failed":undefined;
}

export async function syncAll(options:SyncAllOptions){
  const started=performance.now();const results:SyncResult[]=[];
  async function step(source:string,fn:()=>Promise<unknown>,skip?:string){
    if(skip){console.log(`\n[sync] ${source}: omitido · ${skip}`);results.push({source,status:"skipped",detail:skip});return}
    console.log(`\n[sync] ── ${source} ──`);const t=performance.now();
    try{const result=await fn();const seconds=((performance.now()-t)/1000).toFixed(1);console.log(`[sync] ${source}: listo en ${seconds}s`);if(result!==undefined)console.log(result);results.push({source,status:"ok",detail:`${seconds}s`})}
    catch(e){const message=String(e);console.error(`[sync] ${source}: ERROR · ${message}`);results.push({source,status:"failed",detail:message.slice(0,160)})}
  }

  console.log("[sync] Sincronización incremental de Chile Transparente");
  console.log(options.force?"[sync] --force activo: se ignora freshness y se reintenta todo.":"[sync] Fuentes recientes y recursos ya procesados se omiten. Usa --force para rehacer todo.");
  console.log("[sync] Un fallo no detendrá las demás fuentes.");

  await step("Geografía oficial",()=>syncOfficialRegions(),geographySkip(options));
  await step("Datos.gob catálogo",()=>syncDatosGob(),freshnessSkip("datos-gob",options,"datos-catalog"));
  await step("SINIM / SUBDERE",()=>syncSinim(),freshnessSkip("sinim",options));
  await step("RSH / Calificación Socioeconómica",()=>syncRsh(),freshnessSkip("rsh",options));
  await step("CASEN / estimaciones comunales",()=>syncCasen(),freshnessSkip("casen",options));
  await step("INE / SDMX",()=>syncIne(),freshnessSkip("ine",options));
  await step("SII / empresas por comuna",()=>syncSii(),freshnessSkip("sii",options));
  await step("SERVEL / participación territorial",()=>syncServel(),freshnessSkip("servel",options));
  await step("Presupuesto Abierto / DIPRES",()=>syncPresupuestoAbierto(),freshnessSkip("presupuesto-abierto",options));
  await step("Energía Abierta / CNE",()=>syncEnergiaAbierta(),freshnessSkip("energia-abierta",options));

  const bcSkip=process.env.BCCH_API_KEY?.trim()?freshnessSkip("bcentral",options):"falta BCCH_API_KEY";
  await step("Banco Central",()=>syncBCentral(),bcSkip);

  const today=new Date().toISOString().slice(0,10),from=options.from??process.env.SYNC_CHILECOMPRA_FROM??today,to=options.to??process.env.SYNC_CHILECOMPRA_TO??from;
  const explicitChileCompra=Boolean(options.from||options.to||process.env.SYNC_CHILECOMPRA_FROM||process.env.SYNC_CHILECOMPRA_TO);
  const ccSkip=!process.env.CHILECOMPRA_TICKET?.trim()?"falta CHILECOMPRA_TICKET":explicitChileCompra?undefined:freshnessSkip("chilecompra",options);
  await step(`ChileCompra ${from} → ${to}`,()=>syncChileCompra(from,to),ccSkip);

  await step("Datos.gob recursos",()=>syncDatosGobResources({concurrency:options.concurrency,includeRaw:options.includeRaw,retryFailed:true,force:options.force}),datosResourcesSkip(options));

  const seconds=((performance.now()-started)/1000).toFixed(1);console.log(`\n[sync] Finalizado en ${seconds}s`);console.table(results);
  const failed=results.filter(x=>x.status==="failed").length,skipped=results.filter(x=>x.status==="skipped").length;console.log(`[sync] ok=${results.length-failed-skipped} failed=${failed} skipped=${skipped}`);if(failed)process.exitCode=1;return results;
}
