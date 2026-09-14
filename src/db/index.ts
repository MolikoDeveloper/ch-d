import { Database } from "bun:sqlite";
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

function ensureExtendedSchema(){
  db.exec(`
    CREATE TABLE IF NOT EXISTS elections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES sources(id),
      external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      office_type TEXT NOT NULL,
      election_date TEXT,
      round INTEGER,
      territorial_scope TEXT,
      status TEXT,
      source_url TEXT,
      raw_snapshot_id INTEGER REFERENCES raw_snapshots(id),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(source_id,external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_elections_date ON elections(election_date,office_type);

    CREATE TABLE IF NOT EXISTS election_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      person_id INTEGER REFERENCES persons(id),
      candidate_name TEXT NOT NULL,
      party TEXT,
      coalition TEXT,
      list_name TEXT,
      ballot_number TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(election_id,external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_election_candidates_election ON election_candidates(election_id);

    CREATE TABLE IF NOT EXISTS election_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
      candidate_id INTEGER NOT NULL REFERENCES election_candidates(id) ON DELETE CASCADE,
      geo_area_id INTEGER REFERENCES geo_areas(id),
      votes INTEGER NOT NULL,
      valid_vote_pct REAL,
      total_vote_pct REAL,
      position INTEGER,
      elected INTEGER,
      raw_snapshot_id INTEGER REFERENCES raw_snapshots(id),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(election_id,candidate_id,geo_area_id)
    );
    CREATE INDEX IF NOT EXISTS idx_election_results_geo ON election_results(geo_area_id,election_id);

    CREATE TABLE IF NOT EXISTS election_totals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
      geo_area_id INTEGER REFERENCES geo_areas(id),
      valid_votes INTEGER,
      null_votes INTEGER,
      blank_votes INTEGER,
      total_votes INTEGER,
      registered_voters INTEGER,
      turnout_pct REAL,
      raw_snapshot_id INTEGER REFERENCES raw_snapshots(id),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(election_id,geo_area_id)
    );
    CREATE INDEX IF NOT EXISTS idx_election_totals_geo ON election_totals(geo_area_id,election_id);

    CREATE TABLE IF NOT EXISTS places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES sources(id),
      external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      place_type TEXT NOT NULL,
      geo_area_id INTEGER REFERENCES geo_areas(id),
      address TEXT,
      centroid_lat REAL,
      centroid_lon REAL,
      description TEXT,
      source_url TEXT,
      raw_snapshot_id INTEGER REFERENCES raw_snapshots(id),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(source_id,external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_places_geo ON places(geo_area_id,place_type);
  `);
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
    // Legacy columns remain for compatibility, but response bodies are no longer persisted.
    addColumn("raw_snapshots","content_blob","BLOB");
    addColumn("raw_snapshots","storage_encoding","TEXT NOT NULL DEFAULT 'discarded'");
    addColumn("persons","birth_date","TEXT");

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

    ensureExtendedSchema();
    const { seedGeography } = await import("../geo");
    seedGeography();

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
