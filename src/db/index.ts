import { Database } from "bun:sqlite";
import { gunzipSync } from "node:zlib";
import { SOURCES } from "../domain/sources";

const path = process.env.DB_PATH ?? "./data/chile.sqlite";
export const db = new Database(path, { create: true });

db.exec(`PRAGMA journal_mode=WAL;`);
db.exec(`PRAGMA synchronous=NORMAL;`);
db.exec(`PRAGMA busy_timeout=30000;`);
db.exec(`PRAGMA foreign_keys=ON;`);

function columns(table:string){
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(r=>r.name));
}
function addColumn(table:string, name:string, sql:string){
  if(!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sql}`);
}

function backfillSinimCentroids(){
  const missing=(db.query(`SELECT id,code FROM geo_areas WHERE source_id='sinim' AND geo_type='commune' AND (centroid_lat IS NULL OR centroid_lon IS NULL)`).all() as Array<{id:number;code:string}>);
  if(!missing.length||!columns("raw_snapshots").has("content_blob"))return 0;
  const byCode=new Map(missing.map(x=>[String(x.code),x.id]));
  const snapshots=db.query(`SELECT source_url,content_blob,storage_encoding FROM raw_snapshots WHERE source_id='sinim' AND content_blob IS NOT NULL AND source_url LIKE '%municipio=%' ORDER BY id DESC`).all() as Array<{source_url:string;content_blob:Uint8Array;storage_encoding:string|null}>;
  const update=db.prepare(`UPDATE geo_areas SET centroid_lat=?,centroid_lon=? WHERE id=?`);
  let updated=0;
  for(const s of snapshots){
    let code:string|null=null;try{code=new URL(s.source_url).searchParams.get("municipio")}catch{}
    if(!code||!byCode.has(code))continue;
    try{
      const raw=Buffer.from(s.content_blob);const bytes=s.storage_encoding==="gzip"?gunzipSync(raw):raw;const html=new TextDecoder("utf-8").decode(bytes);
      const m=html.match(/[?&](?:amp;)?ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);if(!m)continue;
      const lat=Number(m[1]),lon=Number(m[2]);if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;
      update.run(lat,lon,byCode.get(code)!);byCode.delete(code);updated++;if(!byCode.size)break;
    }catch{}
  }
  if(updated)console.log(`[db] SINIM: ${updated} centroides comunales recuperados desde snapshots`);
  return updated;
}

export function initDb() {
  const sql = Bun.file(new URL("./schema.sql", import.meta.url));
  return sql.text().then(async (text) => {
    db.exec(text);
    addColumn("source_resources","sync_status","TEXT NOT NULL DEFAULT 'pending'");
    addColumn("source_resources","last_attempt_at","TEXT");
    addColumn("source_resources","last_success_at","TEXT");
    addColumn("source_resources","last_error","TEXT");
    addColumn("source_resources","last_snapshot_id","INTEGER");
    addColumn("source_resources","last_sha256","TEXT");
    addColumn("source_resources","record_count","INTEGER NOT NULL DEFAULT 0");
    addColumn("source_resources","http_etag","TEXT");
    addColumn("source_resources","http_last_modified","TEXT");
    addColumn("source_resources","skip_reason","TEXT");
    addColumn("raw_snapshots","content_blob","BLOB");
    addColumn("raw_snapshots","storage_encoding","TEXT NOT NULL DEFAULT 'identity'");

    const stmt = db.prepare(`
      INSERT INTO sources (id,name,institution,domain,base_url,auth_kind,automatic,metadata_json)
      VALUES ($id,$name,$institution,$domain,$baseUrl,$auth,$automatic,$metadata)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,institution=excluded.institution,domain=excluded.domain,
        base_url=excluded.base_url,auth_kind=excluded.auth_kind,automatic=excluded.automatic,
        metadata_json=excluded.metadata_json
    `);
    db.transaction(() => {
      for (const s of SOURCES) stmt.run({
        $id:s.id,$name:s.name,$institution:s.institution,$domain:s.domain,$baseUrl:s.baseUrl,
        $auth:s.auth,$automatic:s.automatic?1:0,$metadata:JSON.stringify(s)
      });
    })();

    const { seedGeography } = await import("../geo");
    seedGeography();
    backfillSinimCentroids();

    db.exec(`
      INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json)
      SELECT source_id,external_id,title,description,'economia',NULL,NULL,
             json_extract(metadata_json,'$.frequencyCode'),'country',metadata_json
      FROM source_catalog_items
      WHERE source_id='bcentral'
      ON CONFLICT(source_id,external_id) DO UPDATE SET
        title=excluded.title,description=excluded.description,frequency=excluded.frequency,
        metadata_json=excluded.metadata_json;
    `);
  });
}

export function startRun(sourceId: string) {
  const res = db.prepare(`INSERT INTO ingest_runs(source_id,started_at,status) VALUES(?,?,?)`).run(sourceId,new Date().toISOString(),"running");
  return Number(res.lastInsertRowid);
}

export function updateRunProgress(id:number, seen:number, written:number, message:string|null=null){
  db.prepare(`UPDATE ingest_runs SET records_seen=?,records_written=?,message=? WHERE id=?`)
    .run(seen,written,message,id);
}

export function finishRun(id:number,status:"success"|"failed", message:string|null, seen:number, written:number){
  db.prepare(`UPDATE ingest_runs SET finished_at=?,status=?,message=?,records_seen=?,records_written=? WHERE id=?`)
    .run(new Date().toISOString(),status,message,seen,written,id);
}
