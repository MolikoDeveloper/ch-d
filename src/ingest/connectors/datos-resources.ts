import { db, finishRun, startRun } from "../../db";
import { isParseableFormat } from "../parsers/tabular";
import { syncDatosGobResourceByRow, type DatosResourceRow } from "./datos-resource";

export type BatchOptions={
  concurrency?:number;
  limit?:number;
  includeRaw?:boolean;
  retryFailed?:boolean;
  force?:boolean;
};

async function pool<T>(items:T[],concurrency:number,fn:(item:T,index:number)=>Promise<void>){
  let cursor=0;
  const workers=Array.from({length:Math.max(1,concurrency)},async()=>{
    for(;;){
      const index=cursor++; if(index>=items.length) return;
      await fn(items[index],index);
    }
  });
  await Promise.all(workers);
}

export async function syncDatosGobResources(opts:BatchOptions={}){
  const concurrency=Math.max(1,Math.min(opts.concurrency ?? Number(process.env.INGEST_CONCURRENCY ?? 4),16));
  const clauses:string[]=[]; const params:any[]=[];
  if(!opts.force){
    const statuses=["pending"];
    if(opts.retryFailed) statuses.push("failed");
    clauses.push(`sync_status IN (${statuses.map(()=>'?').join(',')})`); params.push(...statuses);
  }
  const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
  const limit=opts.limit && opts.limit>0?`LIMIT ${Math.floor(opts.limit)}`:'';
  let resources=db.query(`SELECT id,external_id,url,format,sync_status,http_etag,http_last_modified FROM source_resources ${where} ORDER BY id ${limit}`).all(...params) as DatosResourceRow[];
  if(!opts.includeRaw) resources=resources.filter(r=>isParseableFormat(r.format,r.url));

  const run=startRun("datos-gob");
  let seen=0,written=0,parsed=0,downloaded=0,unsupported=0,failed=0;
  const started=Date.now();
  try{
    await pool(resources,concurrency,async(resource,index)=>{
      try{
        const r=await syncDatosGobResourceByRow(resource,run,{includeRaw:opts.includeRaw});
        seen+=r.seen; written+=r.written;
        if(r.status==='parsed') parsed++;
        else if(r.status==='downloaded') downloaded++;
        else unsupported++;
      }catch(e){
        failed++;
        console.error(`[${index+1}/${resources.length}] ${resource.external_id}: ${String(e)}`);
      }
      if((index+1)%25===0 || index+1===resources.length){
        const elapsed=Math.max(1,(Date.now()-started)/1000);
        console.log(`[datos.gob] ${index+1}/${resources.length} recursos · parsed=${parsed} failed=${failed} · ${((index+1)/elapsed).toFixed(2)} rec/s`);
      }
    });
    const status=failed===resources.length&&resources.length>0?"failed":"success";
    const message=`resources=${resources.length}; parsed=${parsed}; downloaded=${downloaded}; unsupported=${unsupported}; failed=${failed}`;
    finishRun(run,status,message,seen,written);
    return {resources:resources.length,seen,written,parsed,downloaded,unsupported,failed,concurrency};
  }catch(e){ finishRun(run,"failed",String(e),seen,written); throw e; }
}
