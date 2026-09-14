import { initDb, db } from "../db";
import { SOURCES } from "../domain/sources";
import { syncDatosGob } from "../ingest/connectors/datos-gob";
import { syncChileCompra } from "../ingest/connectors/chilecompra";
import { syncBCentral } from "../ingest/connectors/bcentral";
import { syncDatosGobResource } from "../ingest/connectors/datos-resource";
import { syncDatosGobResources } from "../ingest/connectors/datos-resources";
import { syncEnergiaAbierta } from "../ingest/connectors/energia-abierta";
import { syncSinim } from "../ingest/connectors/sinim";
import { syncIne } from "../ingest/connectors/ine";
import { syncOfficialRegions } from "../geo";

await initDb();
const [command,arg]=Bun.argv.slice(2);
const flag=(name:string)=>Bun.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3);
const boolFlag=(name:string,def=false)=>{const v=flag(name);if(v==null)return Bun.argv.includes(`--${name}`)||def;return["1","true","yes","on"].includes(v.toLowerCase())};

if(command==="db:init") console.log(`SQLite listo: ${process.env.DB_PATH??"./data/chile.sqlite"}`);
else if(command==="sources:list") console.table(SOURCES.map(s=>({id:s.id,domain:s.domain,automatic:s.automatic,auth:s.auth,name:s.name})));
else if(command==="stats"){
  const scalar=(q:string,...p:any[])=>Number((db.query(q).get(...p)as any)?.n??0);
  console.table({sources:scalar("SELECT count(*) n FROM sources"),datasets:scalar("SELECT count(*) n FROM source_catalog_items"),resources:scalar("SELECT count(*) n FROM source_resources"),pending:scalar("SELECT count(*) n FROM source_resources WHERE sync_status='pending'"),parsed:scalar("SELECT count(*) n FROM source_resources WHERE sync_status='parsed'"),downloaded:scalar("SELECT count(*) n FROM source_resources WHERE sync_status='downloaded'"),unsupported:scalar("SELECT count(*) n FROM source_resources WHERE sync_status='unsupported'"),failed:scalar("SELECT count(*) n FROM source_resources WHERE sync_status='failed'"),sourceRecords:scalar("SELECT count(*) n FROM source_records"),transactions:scalar("SELECT count(*) n FROM transactions"),observations:scalar("SELECT count(*) n FROM observations"),metrics:scalar("SELECT count(*) n FROM metric_definitions"),geoAreas:scalar("SELECT count(*) n FROM geo_areas"),rawSnapshots:scalar("SELECT count(*) n FROM raw_snapshots")});
}else if(command==="sync"){
  const target=arg;
  if(!target) console.log("datos-gob:",await syncDatosGob());
  else if(target==="datos-gob") console.log(await syncDatosGob());
  else if(target==="datos-resources") console.log(await syncDatosGobResources({concurrency:Number(flag("concurrency")??process.env.INGEST_CONCURRENCY??4),limit:flag("limit")?Number(flag("limit")):undefined,includeRaw:boolFlag("include-raw"),retryFailed:boolFlag("retry-failed"),force:boolFlag("force")}));
  else if(target==="chilecompra"){const now=new Date().toISOString().slice(0,10);console.log(await syncChileCompra(flag("from")??now,flag("to")??flag("from")??now))}
  else if(target==="bcentral") console.log(await syncBCentral());
  else if(target==="energia-abierta") console.log(await syncEnergiaAbierta());
  else if(target==="sinim") console.log(await syncSinim());
  else if(target==="ine") console.log(await syncIne());
  else if(target==="geo") console.log(await syncOfficialRegions());
  else if(target==="datos-resource"){const id=flag("id");if(!id)throw new Error("Falta --id=<resource-id>");console.log(await syncDatosGobResource(id))}
  else throw new Error(`Fuente automática desconocida: ${target}`);
}else console.log("Comandos: db:init | sources:list | stats | sync [datos-gob|datos-resources|datos-resource|chilecompra|bcentral|energia-abierta|sinim|ine|geo]");
