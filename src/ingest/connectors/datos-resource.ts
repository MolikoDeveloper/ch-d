import { db, finishRun, startRun } from "../../db";
import { fetchAndSnapshot } from "../raw";
import { isParseableFormat, parseResource } from "../parsers/tabular";

function stableStringify(value:unknown):string{
  if(value===null||typeof value!=="object") return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const o=value as Record<string,unknown>;
  return `{${Object.keys(o).sort().map(k=>`${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
function hash(value:unknown){ const h=new Bun.CryptoHasher("sha256"); h.update(stableStringify(value)); return h.digest("hex"); }

export type DatosResourceRow={id:number;external_id:string;url:string;format:string;sync_status:string;http_etag?:string|null;http_last_modified?:string|null};

export async function syncDatosGobResourceByRow(resource:DatosResourceRow,run:number,opts:{includeRaw?:boolean}={}){
  let seen=0,written=0;
  db.prepare(`UPDATE source_resources SET sync_status='downloading',last_attempt_at=?,last_error=NULL,skip_reason=NULL WHERE id=?`).run(new Date().toISOString(),resource.id);
  try{
    const parseable=isParseableFormat(resource.format,resource.url);
    if(!parseable && !opts.includeRaw){
      db.prepare(`UPDATE source_resources SET sync_status='unsupported',skip_reason=?,last_attempt_at=? WHERE id=?`)
        .run(`Formato no estructurado todavía: ${resource.format||'desconocido'}`,new Date().toISOString(),resource.id);
      return {seen,written,status:"unsupported" as const};
    }
    const snap=await fetchAndSnapshot("datos-gob",run,resource.url);
    let rows:Record<string,unknown>[]=[];
    if(parseable) rows=parseResource(resource.format || resource.url,snap.bytes,snap.text);
    const insert=db.prepare(`INSERT OR IGNORE INTO source_records(source_id,resource_id,raw_snapshot_id,ordinal,record_hash,record_json) VALUES(?,?,?,?,?,?)`);
    const tx=db.transaction(()=>{
      rows.forEach((row,i)=>{
        seen++;
        const result=insert.run("datos-gob",resource.id,snap.snapshotId,i,hash(row),JSON.stringify(row));
        if(result.changes) written++;
      });
    });
    tx();
    db.prepare(`UPDATE source_resources SET sync_status=?,last_success_at=?,last_error=NULL,last_snapshot_id=?,last_sha256=?,record_count=(SELECT count(*) FROM source_records WHERE resource_id=?) WHERE id=?`)
      .run(parseable?"parsed":"downloaded",new Date().toISOString(),snap.snapshotId,snap.sha256,resource.id,resource.id);
    return {seen,written,status:(parseable?"parsed":"downloaded") as "parsed"|"downloaded",sha256:snap.sha256};
  }catch(e){
    db.prepare(`UPDATE source_resources SET sync_status='failed',last_error=?,last_attempt_at=? WHERE id=?`).run(String(e),new Date().toISOString(),resource.id);
    throw e;
  }
}

export async function syncDatosGobResource(externalResourceId:string){
  const resource=db.prepare(`SELECT r.id,r.external_id,r.url,r.format,r.sync_status,r.http_etag,r.http_last_modified FROM source_resources r WHERE r.external_id=? LIMIT 1`).get(externalResourceId) as DatosResourceRow|null;
  if(!resource) throw new Error(`Recurso ${externalResourceId} no está indexado. Ejecuta primero: bun run sync:datos`);
  const run=startRun("datos-gob");
  try{
    const result=await syncDatosGobResourceByRow(resource,run,{includeRaw:true});
    finishRun(run,"success",null,result.seen,result.written); return {...result,format:resource.format,url:resource.url};
  }catch(e){ finishRun(run,"failed",String(e),0,0); throw e; }
}
