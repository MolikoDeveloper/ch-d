import { db, finishRun, startRun } from "../../db";
import { fetchAndSnapshot } from "../raw";

const BASE = "https://datos.gob.cl/api/3/action/package_search";

type CkanResource = { id:string; name?:string; format?:string; url?:string|null; datastore_active?:boolean; [k:string]:unknown };
type CkanDataset = { id:string; name:string; title:string; notes?:string; organization?:{title?:string}; metadata_modified?:string; resources:CkanResource[]; [k:string]:unknown };

export async function syncDatosGob(){
  const run = startRun("datos-gob");
  let seen=0,written=0;
  try{
    const rows=100;
    const upsertResource=db.prepare(`
      INSERT INTO source_resources(catalog_item_id,external_id,name,format,url,datastore_active,metadata_json)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(catalog_item_id,external_id) DO UPDATE SET
        name=excluded.name,
        format=excluded.format,
        url=excluded.url,
        datastore_active=excluded.datastore_active,
        metadata_json=excluded.metadata_json,
        sync_status=CASE WHEN COALESCE(source_resources.url,'')<>COALESCE(excluded.url,'') THEN 'pending' ELSE source_resources.sync_status END,
        last_attempt_at=CASE WHEN COALESCE(source_resources.url,'')<>COALESCE(excluded.url,'') THEN NULL ELSE source_resources.last_attempt_at END,
        last_success_at=CASE WHEN COALESCE(source_resources.url,'')<>COALESCE(excluded.url,'') THEN NULL ELSE source_resources.last_success_at END,
        last_error=CASE WHEN COALESCE(source_resources.url,'')<>COALESCE(excluded.url,'') THEN NULL ELSE source_resources.last_error END,
        last_snapshot_id=CASE WHEN COALESCE(source_resources.url,'')<>COALESCE(excluded.url,'') THEN NULL ELSE source_resources.last_snapshot_id END,
        last_sha256=CASE WHEN COALESCE(source_resources.url,'')<>COALESCE(excluded.url,'') THEN NULL ELSE source_resources.last_sha256 END,
        skip_reason=CASE WHEN COALESCE(source_resources.url,'')<>COALESCE(excluded.url,'') THEN NULL ELSE source_resources.skip_reason END
    `);
    for(let start=0;;start+=rows){
      const url=`${BASE}?rows=${rows}&start=${start}`;
      const snap=await fetchAndSnapshot("datos-gob",run,url);
      const body=JSON.parse(snap.text) as {success:boolean; result:{count:number;results:CkanDataset[]}};
      if(!body.success) throw new Error("CKAN devolvió success=false");
      for(const ds of body.result.results){
        seen++;
        db.prepare(`INSERT INTO source_catalog_items(source_id,external_id,title,description,publisher,page_url,metadata_json,updated_at)
          VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,description=excluded.description,publisher=excluded.publisher,page_url=excluded.page_url,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
          .run("datos-gob",ds.id,ds.title,ds.notes ?? null,ds.organization?.title ?? null,`https://datos.gob.cl/dataset/${ds.name}`,JSON.stringify(ds),ds.metadata_modified ?? null);
        const item=(db.prepare(`SELECT id FROM source_catalog_items WHERE source_id='datos-gob' AND external_id=?`).get(ds.id) as {id:number}).id;
        for(const r of ds.resources ?? []){
          upsertResource.run(item,r.id,r.name ?? null,(r.format ?? "").toUpperCase(),String(r.url??"").trim(),r.datastore_active?1:0,JSON.stringify(r));
        }
        written++;
      }
      if(start+rows>=body.result.count) break;
    }
    finishRun(run,"success","catalog",seen,written);
    return {seen,written};
  }catch(e){ finishRun(run,"failed",String(e),seen,written); throw e; }
}
