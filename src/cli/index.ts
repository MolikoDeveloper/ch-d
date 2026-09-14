import { initDb, db } from "../db";
import { SOURCES } from "../domain/sources";
import { syncDatosGob } from "../ingest/connectors/datos-gob";
import { syncChileCompra } from "../ingest/connectors/chilecompra";
import { syncBCentral } from "../ingest/connectors/bcentral";
import { syncDatosGobResource } from "../ingest/connectors/datos-resource";
import { syncDatosGobResources } from "../ingest/connectors/datos-resources";
import { syncEnergiaAbierta } from "../ingest/connectors/energia-abierta";
import { syncSinim } from "../ingest/connectors/sinim";
import { syncRsh } from "../ingest/connectors/rsh";
import { syncCasen } from "../ingest/connectors/casen";
import { syncSii } from "../ingest/connectors/sii";
import { syncServel } from "../ingest/connectors/servel";
import { syncPresupuestoAbierto } from "../ingest/connectors/presupuesto-abierto";
import { syncPresidencia } from "../ingest/connectors/presidencia";
import { syncApproval } from "../ingest/connectors/approval";
import { syncIne } from "../ingest/connectors/ine";
import { syncOfficialRegions } from "../geo";
import { syncAll } from "./sync-all";
import { purgeRawBodies } from "./purge-raw";

await initDb();
const [command,arg]=Bun.argv.slice(2);
const flag=(name:string)=>Bun.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3);
const boolFlag=(name:string,def=false)=>{const v=flag(name);if(v==null)return Bun.argv.includes(`--${name}`)||def;return["1","true","yes","on"].includes(v.toLowerCase())};

if(command==="db:init") console.log(`SQLite listo: ${process.env.DB_PATH??"./data/chile.sqlite"}`);
else if(command==="db:purge-raw") console.log(purgeRawBodies({vacuum:boolFlag("vacuum"),batchSize:Number(flag("batch-size")??50),deleteFiles:!boolFlag("keep-files")}));
else if(command==="sources:list") console.table(SOURCES.map(s=>({id:s.id,domain:s.domain,automatic:s.automatic,auth:s.auth,name:s.name})));
else if(command==="stats"){
  const scalar=(q:string,...p:any[])=>Number((db.query(q).get(...p)as any)?.n??0);
  console.table({sources:scalar("SELECT count(*) n FROM sources"),datasets:scalar("SELECT count(*) n FROM source_catalog_items"),resources:scalar("SELECT count(*) n FROM source_resources"),pending:scalar("SELECT count(*) n FROM source_resources WHERE sync_status='pending'"),parsed:scalar("SELECT count(*) n FROM source_resources WHERE sync_status='parsed'"),downloaded:scalar("SELECT count(*) n FROM source_resources WHERE sync_status='downloaded'"),unsupported:scalar("SELECT count(*) n FROM source_resources WHERE sync_status='unsupported'"),failed:scalar("SELECT count(*) n FROM source_resources WHERE sync_status='failed'"),sourceRecords:scalar("SELECT count(*) n FROM source_records"),transactions:scalar("SELECT count(*) n FROM transactions"),observations:scalar("SELECT count(*) n FROM observations"),metrics:scalar("SELECT count(*) n FROM metric_definitions"),elections:scalar("SELECT count(*) n FROM elections"),electionResults:scalar("SELECT count(*) n FROM election_results"),places:scalar("SELECT count(*) n FROM places"),geoAreas:scalar("SELECT count(*) n FROM geo_areas"),rawSnapshots:scalar("SELECT count(*) n FROM raw_snapshots"),rawBodies:scalar("SELECT count(*) n FROM raw_snapshots WHERE content_blob IS NOT NULL"),rawBytes:scalar("SELECT COALESCE(SUM(length(content_blob)),0) n FROM raw_snapshots WHERE content_blob IS NOT NULL")});
}else if(command==="sync"){
  const target=arg;
  if(!target||target==="all"){
    await syncAll({concurrency:Number(flag("concurrency")??process.env.INGEST_CONCURRENCY??4),includeRaw:false,force:boolFlag("force"),from:flag("from"),to:flag("to")});
  }
  else if(target==="datos-gob") console.log(await syncDatosGob());
  else if(target==="datos-resources") console.log(await syncDatosGobResources({concurrency:Number(flag("concurrency")??process.env.INGEST_CONCURRENCY??4),limit:flag("limit")?Number(flag("limit")):undefined,includeRaw:false,retryFailed:boolFlag("retry-failed"),force:boolFlag("force")}));
  else if(target==="chilecompra"){const now=new Date().toISOString().slice(0,10);console.log(await syncChileCompra(flag("from")??now,flag("to")??flag("from")??now))}
  else if(target==="bcentral") console.log(await syncBCentral());
  else if(target==="energia-abierta") console.log(await syncEnergiaAbierta());
  else if(target==="sinim") console.log(await syncSinim());
  else if(target==="rsh") console.log(await syncRsh());
  else if(target==="casen") console.log(await syncCasen());
  else if(target==="sii") console.log(await syncSii());
  else if(target==="servel") console.log(await syncServel());
  else if(target==="presupuesto-abierto") console.log(await syncPresupuestoAbierto());
  else if(target==="presidencia") console.log(await syncPresidencia());
  else if(target==="approval") console.log(await syncApproval());
  else if(target==="ine") console.log(await syncIne());
  else if(target==="geo") console.log(await syncOfficialRegions());
  else if(target==="datos-resource"){const id=flag("id");if(!id)throw new Error("Falta --id=<resource-id>");console.log(await syncDatosGobResource(id))}
  else throw new Error(`Fuente automática desconocida: ${target}`);
}else console.log("Comandos: db:init | db:purge-raw [--vacuum] | sources:list | stats | sync [all|datos-gob|datos-resources|datos-resource|chilecompra|bcentral|energia-abierta|sinim|rsh|casen|sii|servel|presupuesto-abierto|presidencia|approval|ine|geo]");
