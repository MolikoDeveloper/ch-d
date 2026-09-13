import { initDb, db } from "../db";
import { SOURCES } from "../domain/sources";
import { syncDatosGob } from "../ingest/connectors/datos-gob";
import { syncChileCompra } from "../ingest/connectors/chilecompra";
import { syncBCentral } from "../ingest/connectors/bcentral";
import { syncDatosGobResource } from "../ingest/connectors/datos-resource";

await initDb();

const [command, arg] = Bun.argv.slice(2);
const flag=(name:string)=>{
  const p=Bun.argv.find((v)=>v.startsWith(`--${name}=`));
  return p?.slice(name.length+3);
};

switch(command){
  case "db:init":
    console.log(`SQLite listo: ${process.env.DB_PATH ?? "./data/chile.sqlite"}`);
    break;
  case "sources:list":
    console.table(SOURCES.map(s=>({id:s.id,domain:s.domain,automatic:s.automatic,auth:s.auth,name:s.name})));
    break;
  case "stats": {
    const scalar=(q:string)=>Number((db.query(q).get() as any)?.n ?? 0);
    console.table({
      sources:scalar("SELECT count(*) n FROM sources"),
      datasets:scalar("SELECT count(*) n FROM source_catalog_items"),
      resources:scalar("SELECT count(*) n FROM source_resources"),
      transactions:scalar("SELECT count(*) n FROM transactions"),
      observations:scalar("SELECT count(*) n FROM observations"),
      rawSnapshots:scalar("SELECT count(*) n FROM raw_snapshots")
    });
    break;
  }
  case "sync": {
    const target=arg;
    if(!target){
      console.log("Sincronizando fuentes automáticas que no requieren credenciales...");
      console.log("datos-gob:", await syncDatosGob());
      console.log("ChileCompra y Banco Central se omiten sin credenciales explícitas.");
      break;
    }
    if(target==="datos-gob") console.log(await syncDatosGob());
    else if(target==="chilecompra"){
      const now=new Date().toISOString().slice(0,10);
      console.log(await syncChileCompra(flag("from") ?? now, flag("to") ?? flag("from") ?? now));
    }
    else if(target==="bcentral") console.log(await syncBCentral());
    else if(target==="datos-resource"){
      const resourceId=flag("id");
      if(!resourceId) throw new Error("Falta --id=<resource-id> para datos-resource");
      console.log(await syncDatosGobResource(resourceId));
    }
    else throw new Error(`Fuente automática desconocida: ${target}`);
    break;
  }
  default:
    console.log(`Chile Transparente CLI\n\nComandos:\n  db:init\n  sources:list\n  stats\n  sync [datos-gob|datos-resource|chilecompra|bcentral]\n\ndatos-resource acepta --id=<resource-id>\nChileCompra acepta --from=YYYY-MM-DD --to=YYYY-MM-DD`);
}
