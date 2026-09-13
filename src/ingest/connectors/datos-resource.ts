import { db, finishRun, startRun } from "../../db";
import { fetchAndSnapshot } from "../raw";
import { parseResource } from "../parsers/tabular";

function stableStringify(value:unknown):string{
  if(value===null||typeof value!=="object") return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const o=value as Record<string,unknown>;
  return `{${Object.keys(o).sort().map(k=>`${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
function hash(value:unknown){ const h=new Bun.CryptoHasher("sha256"); h.update(stableStringify(value)); return h.digest("hex"); }

export async function syncDatosGobResource(externalResourceId:string){
  const resource=db.prepare(`SELECT r.id,r.url,r.format FROM source_resources r WHERE r.external_id=? LIMIT 1`).get(externalResourceId) as {id:number;url:string;format:string}|null;
  if(!resource) throw new Error(`Recurso ${externalResourceId} no está indexado. Ejecuta primero: bun run sync:datos`);
  const run=startRun("datos-gob"); let seen=0,written=0;
  try{
    const snap=await fetchAndSnapshot("datos-gob",run,resource.url);
    const rows=parseResource(resource.format ?? "",snap.bytes,snap.text);
    const insert=db.prepare(`INSERT OR IGNORE INTO source_records(source_id,resource_id,raw_snapshot_id,ordinal,record_hash,record_json) VALUES(?,?,?,?,?,?)`);
    const tx=db.transaction(()=>{
      rows.forEach((row,i)=>{
        seen++;
        const result=insert.run("datos-gob",resource.id,snap.snapshotId,i,hash(row),JSON.stringify(row));
        if(result.changes) written++;
      });
    });
    tx();
    finishRun(run,"success",null,seen,written); return {seen,written,format:resource.format,url:resource.url};
  }catch(e){ finishRun(run,"failed",String(e),seen,written); throw e; }
}
