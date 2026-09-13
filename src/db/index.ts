import { Database } from "bun:sqlite";
import { SOURCES } from "../domain/sources";

const path = process.env.DB_PATH ?? "./data/chile.sqlite";
export const db = new Database(path, { create: true });

function columns(table:string){
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(r=>r.name));
}
function addColumn(table:string, name:string, sql:string){
  if(!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sql}`);
}

export function initDb() {
  const sql = Bun.file(new URL("./schema.sql", import.meta.url));
  return sql.text().then((text) => {
    db.exec(text);

    // Lightweight migrations for databases created by earlier project versions.
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
    db.exec(`CREATE INDEX IF NOT EXISTS idx_resources_sync_status ON source_resources(sync_status)`);

    const stmt = db.prepare(`
      INSERT INTO sources (id,name,institution,domain,base_url,auth_kind,automatic,metadata_json)
      VALUES ($id,$name,$institution,$domain,$baseUrl,$auth,$automatic,$metadata)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,institution=excluded.institution,domain=excluded.domain,
        base_url=excluded.base_url,auth_kind=excluded.auth_kind,automatic=excluded.automatic,
        metadata_json=excluded.metadata_json
    `);
    const tx = db.transaction(() => {
      for (const s of SOURCES) stmt.run({
        $id:s.id,$name:s.name,$institution:s.institution,$domain:s.domain,$baseUrl:s.baseUrl,
        $auth:s.auth,$automatic:s.automatic?1:0,$metadata:JSON.stringify(s)
      });
    });
    tx();
  });
}

export function startRun(sourceId: string) {
  const res = db.prepare(`INSERT INTO ingest_runs(source_id,started_at,status) VALUES(?,?,?)`).run(sourceId,new Date().toISOString(),"running");
  return Number(res.lastInsertRowid);
}

export function finishRun(id:number,status:"success"|"failed", message:string|null, seen:number, written:number){
  db.prepare(`UPDATE ingest_runs SET finished_at=?,status=?,message=?,records_seen=?,records_written=? WHERE id=?`)
    .run(new Date().toISOString(),status,message,seen,written,id);
}
