import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { db } from "../db";

function safePart(v:string){ return v.replace(/[^a-zA-Z0-9._-]+/g,"_").slice(0,160); }

export async function fetchAndSnapshot(sourceId:string, runId:number, url:string, init?:RequestInit){
  const response = await fetch(url, init);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const sha256 = hasher.digest("hex");
  const date = new Date();
  const rel = join(sourceId, date.toISOString().slice(0,10), `${safePart(sha256)}.bin`);
  const localPath = join("data/raw", rel);
  await mkdir(dirname(localPath), { recursive:true });
  await Bun.write(localPath, bytes);

  db.prepare(`INSERT OR IGNORE INTO raw_snapshots
    (source_id,ingest_run_id,fetched_at,source_url,content_type,sha256,byte_size,local_path,http_status)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(sourceId,runId,date.toISOString(),url,response.headers.get("content-type"),sha256,bytes.byteLength,localPath,response.status);

  const row = db.prepare(`SELECT id FROM raw_snapshots WHERE source_id=? AND sha256=?`).get(sourceId,sha256) as {id:number};
  if(!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return { snapshotId: row.id, response, bytes, text: new TextDecoder().decode(bytes), sha256, localPath };
}
