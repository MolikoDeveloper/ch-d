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
type ResourceStatus="parsed"|"unsupported";

function invalidUrlReason(raw:unknown){
  const value=String(raw??"").trim();
  if(!value)return"URL vacía en el catálogo de Datos.gob";
  try{
    const url=new URL(value);
    if(url.protocol!=="http:"&&url.protocol!=="https:")return`Esquema de URL no soportado: ${url.protocol}`;
    return null;
  }catch{return"URL inválida en el catálogo de Datos.gob"}
}

function permanentFailureReason(error:unknown){
  const message=String(error);
  const match=message.match(/\bHTTP\s+(\d{3})\b/i);
  if(match){
    const status=Number(match[1]);
    if(status===404)return"Recurso remoto inexistente (HTTP 404)";
    if(status===410)return"Recurso remoto retirado (HTTP 410)";
    if(status===400)return"Solicitud del recurso rechazada permanentemente (HTTP 400)";
    if(status===422)return"URL/recurso no procesable por el servidor (HTTP 422)";
  }
  if(/ERR_INVALID_URL|URL must not be a blank string|invalid url/i.test(message))return"URL inválida en el catálogo de Datos.gob";
  return null;
}

function markUnsupported(resourceId:number,reason:string,error?:unknown){
  db.prepare(`UPDATE source_resources
    SET sync_status='unsupported',skip_reason=?,last_error=?,last_attempt_at=?
    WHERE id=?`)
    .run(reason,error==null?null:String(error),new Date().toISOString(),resourceId);
}

export async function syncDatosGobResourceByRow(resource:DatosResourceRow,run:number,_opts:{includeRaw?:boolean}={}){
  let seen=0,written=0;
  const badUrl=invalidUrlReason(resource.url);
  if(badUrl){markUnsupported(resource.id,badUrl);return {seen,written,status:"unsupported" as ResourceStatus,reason:badUrl}}

  const parseable=isParseableFormat(resource.format,resource.url);
  if(!parseable){
    const reason=`Formato no estructurado todavía: ${resource.format||'desconocido'} · RAW no se conserva`;
    markUnsupported(resource.id,reason);
    return {seen,written,status:"unsupported" as ResourceStatus,reason};
  }

  db.prepare(`UPDATE source_resources SET sync_status='downloading',last_attempt_at=?,last_error=NULL,skip_reason=NULL WHERE id=?`).run(new Date().toISOString(),resource.id);
  try{
    const snap=await fetchAndSnapshot("datos-gob",run,resource.url);
    const rows=parseResource(resource.format || resource.url,snap.bytes,snap.text);
    const insert=db.prepare(`INSERT OR IGNORE INTO source_records(source_id,resource_id,raw_snapshot_id,ordinal,record_hash,record_json) VALUES(?,?,?,?,?,?)`);
    db.transaction(()=>{
      rows.forEach((row,i)=>{
        seen++;
        const result=insert.run("datos-gob",resource.id,snap.snapshotId,i,hash(row),JSON.stringify(row));
        if(result.changes) written++;
      });
    })();
    db.prepare(`UPDATE source_resources SET sync_status='parsed',last_success_at=?,last_error=NULL,skip_reason=NULL,last_snapshot_id=?,last_sha256=?,record_count=(SELECT count(*) FROM source_records WHERE resource_id=?) WHERE id=?`)
      .run(new Date().toISOString(),snap.snapshotId,snap.sha256,resource.id,resource.id);
    return {seen,written,status:"parsed" as ResourceStatus,sha256:snap.sha256};
  }catch(e){
    const permanent=permanentFailureReason(e);
    if(permanent){markUnsupported(resource.id,permanent,e);return {seen,written,status:"unsupported" as ResourceStatus,reason:permanent}}
    db.prepare(`UPDATE source_resources SET sync_status='failed',last_error=?,last_attempt_at=?,skip_reason=NULL WHERE id=?`).run(String(e),new Date().toISOString(),resource.id);
    throw e;
  }
}

export async function syncDatosGobResource(externalResourceId:string){
  const resource=db.prepare(`SELECT r.id,r.external_id,r.url,r.format,r.sync_status,r.http_etag,r.http_last_modified FROM source_resources r WHERE r.external_id=? LIMIT 1`).get(externalResourceId) as DatosResourceRow|null;
  if(!resource) throw new Error(`Recurso ${externalResourceId} no está indexado. Ejecuta primero: bun run sync:datos`);
  const run=startRun("datos-gob");
  try{
    const result=await syncDatosGobResourceByRow(resource,run);
    finishRun(run,"success",result.status==="unsupported"?result.reason??"unsupported":null,result.seen,result.written);return {...result,format:resource.format,url:resource.url};
  }catch(e){finishRun(run,"failed",String(e),0,0);throw e}
}
