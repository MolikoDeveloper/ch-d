import { existsSync, statSync, unlinkSync } from "node:fs";
import { resolve, relative } from "node:path";
import { db } from "../db";

type PurgeOptions={vacuum?:boolean;batchSize?:number;deleteFiles?:boolean};
type RawRow={id:number;bytes:number;local_path:string|null};

const dbPath=process.env.DB_PATH??"./data/chile.sqlite";
function human(bytes:number){if(!Number.isFinite(bytes)||bytes<=0)return"0 B";const units=["B","KiB","MiB","GiB","TiB"];let n=bytes,i=0;while(n>=1024&&i<units.length-1){n/=1024;i++}return`${n.toFixed(i?1:0)} ${units[i]}`}
function scalar(q:string,...p:any[]){return Number((db.query(q).get(...p)as any)?.n??0)}
function fileSize(){try{return statSync(dbPath).size}catch{return 0}}
function pageStats(){const pageSize=scalar("PRAGMA page_size"),pages=scalar("PRAGMA page_count"),free=scalar("PRAGMA freelist_count");return{pageSize,pages,free,logicalBytes:pages*pageSize,reclaimableBytes:free*pageSize}}
function rawStats(){return{
  snapshots:scalar("SELECT COUNT(*) n FROM raw_snapshots"),
  bodies:scalar("SELECT COUNT(*) n FROM raw_snapshots WHERE content_blob IS NOT NULL"),
  bodyBytes:scalar("SELECT COALESCE(SUM(length(content_blob)),0) n FROM raw_snapshots WHERE content_blob IS NOT NULL"),
  localFiles:scalar("SELECT COUNT(*) n FROM raw_snapshots WHERE local_path IS NOT NULL AND trim(local_path)<>''"),
}}
function under(root:string,path:string){const r=relative(root,path);return r===""||(!r.startsWith("..")&&!r.startsWith("/"))}
function deleteRecordedFile(raw:string){
  const path=resolve(raw),roots=[resolve("data/raw"),resolve(dbPath,"../raw")];
  if(!roots.some(root=>under(root,path)))return false;
  try{if(existsSync(path))unlinkSync(path);return true}catch{return false}
}

export function purgeRawBodies(options:PurgeOptions={}){
  const batchSize=Math.max(1,Math.min(options.batchSize??50,500)),deleteFiles=options.deleteFiles!==false;
  const before=rawStats(),pagesBefore=pageStats(),diskBefore=fileSize();
  console.log(`[db] RAW: ${before.bodies} blobs · ${human(before.bodyBytes)} comprimidos almacenados`);
  console.log(`[db] SQLite: ${human(diskBefore||pagesBefore.logicalBytes)} · libres internos=${human(pagesBefore.reclaimableBytes)}`);

  let rowsPurged=0,bytesPurged=0,filesDeleted=0,filesKept=0,batch=0;
  const update=db.prepare(`UPDATE raw_snapshots SET content_blob=NULL,storage_encoding='discarded',local_path=? WHERE id=?`);
  for(;;){
    const rows=db.query(`SELECT id,COALESCE(length(content_blob),0) bytes,local_path FROM raw_snapshots WHERE content_blob IS NOT NULL OR (local_path IS NOT NULL AND trim(local_path)<>'') ORDER BY id LIMIT ?`).all(batchSize) as RawRow[];
    if(!rows.length)break;
    db.transaction(()=>{
      for(const row of rows){
        let keepPath=row.local_path;
        if(row.local_path&&deleteFiles){if(deleteRecordedFile(row.local_path)){keepPath=null;filesDeleted++}else filesKept++}
        else if(!row.local_path)keepPath=null;
        update.run(keepPath,row.id);rowsPurged++;bytesPurged+=Number(row.bytes||0);
      }
    })();
    batch++;
    // Keep the WAL bounded while freeing very large BLOB overflow pages.
    try{db.exec("PRAGMA wal_checkpoint(TRUNCATE)")}catch{}
    if(batch===1||batch%20===0)console.log(`[db] RAW purge: ${rowsPurged} snapshots · ${human(bytesPurged)} liberados lógicamente`);
  }

  db.exec("PRAGMA optimize");
  try{db.exec("PRAGMA wal_checkpoint(TRUNCATE)")}catch{}
  const afterPurge=rawStats(),pagesAfterPurge=pageStats();
  console.log(`[db] RAW purge terminado: blobs=${afterPurge.bodies} · bytes=${human(afterPurge.bodyBytes)}`);
  if(filesDeleted)console.log(`[db] Archivos RAW locales eliminados: ${filesDeleted}`);
  if(filesKept)console.warn(`[db] ${filesKept} rutas RAW no se eliminaron por seguridad (fuera de data/raw o inaccesibles).`);
  console.log(`[db] Espacio SQLite reutilizable antes de compactar: ${human(pagesAfterPurge.reclaimableBytes)}`);

  if(options.vacuum){
    console.log("[db] Compactando SQLite con VACUUM. Esto puede tardar bastante y necesita espacio temporal...");
    const started=Date.now();
    db.exec("VACUUM");
    try{db.exec("PRAGMA wal_checkpoint(TRUNCATE)")}catch{}
    const pagesAfter=pageStats(),diskAfter=fileSize();
    console.log(`[db] VACUUM terminado en ${((Date.now()-started)/1000).toFixed(1)}s`);
    console.log(`[db] Tamaño final: ${human(diskAfter||pagesAfter.logicalBytes)} (antes ${human(diskBefore||pagesBefore.logicalBytes)})`);
  }else{
    console.log("[db] Los RAW ya fueron eliminados lógicamente. Para reducir el archivo físico ejecuta:");
    console.log("     bun run db:purge-raw -- --vacuum");
  }

  return{rowsPurged,bytesPurged,filesDeleted,filesKept,before,after:rawStats(),pages:pageStats()};
}
