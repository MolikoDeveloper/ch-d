import { db, finishRun, startRun } from "../../db";
import { syncDatosGobResourceByRow, type DatosResourceRow } from "./datos-resource";

export type BatchOptions={
  concurrency?:number;
  limit?:number;
  /** Deprecated: RAW bodies are never persisted. */
  includeRaw?:boolean;
  retryFailed?:boolean;
  force?:boolean;
};

async function pool<T>(items:T[],concurrency:number,fn:(item:T,index:number)=>Promise<void>){
  let cursor=0;
  const workers=Array.from({length:Math.max(1,concurrency)},async()=>{
    for(;;){const index=cursor++;if(index>=items.length)return;await fn(items[index],index)}
  });
  await Promise.all(workers);
}

function retireKnownPermanentFailures(){
  const result=db.prepare(`
    UPDATE source_resources
       SET sync_status='unsupported',
           skip_reason=CASE
             WHEN trim(COALESCE(url,''))='' THEN 'URL vacía en el catálogo de Datos.gob'
             WHEN last_error LIKE '%HTTP 404 %' THEN 'Recurso remoto inexistente (HTTP 404)'
             WHEN last_error LIKE '%HTTP 410 %' THEN 'Recurso remoto retirado (HTTP 410)'
             WHEN last_error LIKE '%HTTP 400 %' THEN 'Solicitud del recurso rechazada permanentemente (HTTP 400)'
             WHEN last_error LIKE '%HTTP 422 %' THEN 'URL/recurso no procesable por el servidor (HTTP 422)'
             WHEN last_error LIKE '%ERR_INVALID_URL%' OR last_error LIKE '%blank string%' OR last_error LIKE '%Invalid URL%' THEN 'URL inválida en el catálogo de Datos.gob'
             ELSE skip_reason
           END
     WHERE sync_status='failed'
       AND (
         trim(COALESCE(url,''))=''
         OR last_error LIKE '%HTTP 404 %'
         OR last_error LIKE '%HTTP 410 %'
         OR last_error LIKE '%HTTP 400 %'
         OR last_error LIKE '%HTTP 422 %'
         OR last_error LIKE '%ERR_INVALID_URL%'
         OR last_error LIKE '%blank string%'
         OR last_error LIKE '%Invalid URL%'
       )
  `).run();
  return Number(result.changes??0);
}

export async function syncDatosGobResources(opts:BatchOptions={}){
  const retired=opts.force?0:retireKnownPermanentFailures();
  if(retired)console.log(`[datos.gob] ${retired} fallos permanentes antiguos reclasificados como unsupported`);

  const concurrency=Math.max(1,Math.min(opts.concurrency ?? Number(process.env.INGEST_CONCURRENCY ?? 4),16));
  const clauses:string[]=[];const params:any[]=[];
  if(!opts.force){
    const statuses=["pending"];if(opts.retryFailed)statuses.push("failed");
    clauses.push(`sync_status IN (${statuses.map(()=>'?').join(',')})`);params.push(...statuses);
  }
  const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'',limit=opts.limit&&opts.limit>0?`LIMIT ${Math.floor(opts.limit)}`:'';
  const resources=db.query(`SELECT id,external_id,url,format,sync_status,http_etag,http_last_modified FROM source_resources ${where} ORDER BY id ${limit}`).all(...params) as DatosResourceRow[];

  const run=startRun("datos-gob");
  let seen=0,written=0,parsed=0,unsupported=0,failed=0;const started=Date.now();
  try{
    await pool(resources,concurrency,async(resource,index)=>{
      try{
        const r=await syncDatosGobResourceByRow(resource,run);
        seen+=r.seen;written+=r.written;
        if(r.status==='parsed')parsed++;else unsupported++;
      }catch(e){failed++;console.error(`[${index+1}/${resources.length}] ${resource.external_id}: ${String(e)}`)}
      if((index+1)%25===0||index+1===resources.length){const elapsed=Math.max(1,(Date.now()-started)/1000);console.log(`[datos.gob] ${index+1}/${resources.length} recursos · parsed=${parsed} unsupported=${unsupported} failed=${failed} · ${((index+1)/elapsed).toFixed(2)} rec/s`)}
    });
    const status=failed===resources.length&&resources.length>0?"failed":"success",message=`resources=${resources.length}; parsed=${parsed}; unsupported=${unsupported}; retired=${retired}; failed=${failed}`;
    finishRun(run,status,message,seen,written);
    return{resources:resources.length,seen,written,parsed,unsupported,retired,failed,concurrency};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
