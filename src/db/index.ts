import { Database } from "bun:sqlite";
import { SOURCES } from "../domain/sources";

const path = process.env.DB_PATH ?? "./data/chile.sqlite";
export const db = new Database(path, { create: true });

export function initDb() {
  const sql = Bun.file(new URL("./schema.sql", import.meta.url));
  return sql.text().then((text) => {
    db.exec(text);
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
