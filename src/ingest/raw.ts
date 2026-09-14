import { gzipSync, gunzipSync } from "node:zlib";
import { db } from "../db";

function redactUrl(raw:string){
  try {
    const url = new URL(raw);
    const sensitive = new Set(["token","api_key","apikey","key","password","pass","ticket","secret"]);
    for (const key of [...url.searchParams.keys()]) {
      if (sensitive.has(key.toLowerCase())) url.searchParams.set(key,"[REDACTED]");
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function decodeText(bytes:Uint8Array, contentType:string|null){
  const match=/charset\s*=\s*([^;\s]+)/i.exec(contentType??"");
  const raw=(match?.[1]??"utf-8").replace(/["']/g,"").toLowerCase();
  const charset=raw==="latin1"?"windows-1252":raw;
  try { return new TextDecoder(charset).decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

export function loadSnapshotBytes(snapshotId:number){
  const row=db.prepare(`SELECT content_blob,storage_encoding FROM raw_snapshots WHERE id=?`).get(snapshotId) as {content_blob:Uint8Array|null;storage_encoding:string|null}|null;
  if(!row?.content_blob) return null;
  const bytes=new Uint8Array(row.content_blob);
  return row.storage_encoding==="gzip"?new Uint8Array(gunzipSync(bytes)):bytes;
}

export async function fetchAndSnapshot(sourceId:string, runId:number, url:string, init?:RequestInit){
  const response = await fetch(url, init);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const sha256 = hasher.digest("hex");
  const date = new Date();
  const storedUrl = redactUrl(url);
  const contentType=response.headers.get("content-type");
  const compressed=new Uint8Array(gzipSync(bytes,{level:6}));

  db.prepare(`INSERT OR IGNORE INTO raw_snapshots
    (source_id,ingest_run_id,fetched_at,source_url,content_type,sha256,byte_size,local_path,content_blob,storage_encoding,http_status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(sourceId,runId,date.toISOString(),storedUrl,contentType,sha256,bytes.byteLength,null,compressed,"gzip",response.status);

  // Old snapshots may already exist by hash with only local_path populated.
  db.prepare(`UPDATE raw_snapshots SET content_blob=?,storage_encoding='gzip',local_path=NULL
    WHERE source_id=? AND sha256=? AND content_blob IS NULL`)
    .run(compressed,sourceId,sha256);

  const row = db.prepare(`SELECT id FROM raw_snapshots WHERE source_id=? AND sha256=?`).get(sourceId,sha256) as {id:number};
  if(!response.ok) throw new Error(`HTTP ${response.status} ${storedUrl}`);
  return { snapshotId: row.id, response, bytes, text: decodeText(bytes,contentType), sha256, localPath:null };
}
