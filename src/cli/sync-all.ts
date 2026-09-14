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

export async function syncAll(options:SyncAllOptions){
  const started=performance.now();const results:SyncResult[]=[];
  async function step(source:string,fn:()=>Promise<unknown>,skip?:string){
    if(skip){console.log(`\n[sync] ${source}: omitido · ${skip}`);results.push({source,status:"skipped",detail:skip});return}
    console.log(`\n[sync] ── ${source} ──`);const t=performance.now();
    try{const result=await fn();const seconds=((performance.now()-t)/1000).toFixed(1);console.log(`[sync] ${source}: listo en ${seconds}s`);if(result!==undefined)console.log(result);results.push({source,status:"ok",detail:`${seconds}s`})}
    catch(e){const message=String(e);console.error(`[sync] ${source}: ERROR · ${message}`);results.push({source,status:"failed",detail:message.slice(0,160)})}
  }

  console.log("[sync] Sincronización completa de Chile Transparente");
  console.log("[sync] Un fallo no detendrá las demás fuentes.");

  await step("Geografía oficial",()=>syncOfficialRegions());
  await step("Datos.gob catálogo",()=>syncDatosGob());
  await step("SINIM / SUBDERE",()=>syncSinim());
  await step("RSH / Calificación Socioeconómica",()=>syncRsh());
  await step("CASEN / estimaciones comunales",()=>syncCasen());
  await step("INE / SDMX",()=>syncIne());
  await step("SII / empresas por comuna",()=>syncSii());
  await step("SERVEL / participación territorial",()=>syncServel());
  await step("Presupuesto Abierto / DIPRES",()=>syncPresupuestoAbierto());
  await step("Energía Abierta / CNE",()=>syncEnergiaAbierta());

  await step("Banco Central",()=>syncBCentral(),process.env.BCCH_API_KEY?.trim()?undefined:"falta BCCH_API_KEY");

  const today=new Date().toISOString().slice(0,10),from=options.from??process.env.SYNC_CHILECOMPRA_FROM??today,to=options.to??process.env.SYNC_CHILECOMPRA_TO??from;
  await step(`ChileCompra ${from} → ${to}`,()=>syncChileCompra(from,to),process.env.CHILECOMPRA_TICKET?.trim()?undefined:"falta CHILECOMPRA_TICKET");

  await step("Datos.gob recursos",()=>syncDatosGobResources({concurrency:options.concurrency,includeRaw:options.includeRaw,retryFailed:true,force:options.force}));

  const seconds=((performance.now()-started)/1000).toFixed(1);console.log(`\n[sync] Finalizado en ${seconds}s`);console.table(results);
  const failed=results.filter(x=>x.status==="failed").length,skipped=results.filter(x=>x.status==="skipped").length;console.log(`[sync] ok=${results.length-failed-skipped} failed=${failed} skipped=${skipped}`);if(failed)process.exitCode=1;return results;
}
