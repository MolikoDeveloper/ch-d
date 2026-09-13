import { initDb, db } from "../db";
import { SOURCES } from "../domain/sources";

await initDb();
const port=Number(process.env.PORT ?? 3000);

function json(data:unknown,status=200){ return Response.json(data,{status,headers:{"cache-control":"no-store"}}); }
function num(q:string,...params:any[]){ return Number((db.query(q).get(...params) as any)?.n ?? 0); }

const server=Bun.serve({
  port,
  async fetch(req){
    const url=new URL(req.url);
    if(url.pathname==="/api/health") return json({ok:true,time:new Date().toISOString()});
    if(url.pathname==="/api/sources") return json(SOURCES);
    if(url.pathname==="/api/summary") return json({
      sources:num("SELECT count(*) n FROM sources"),
      catalogItems:num("SELECT count(*) n FROM source_catalog_items"),
      resources:num("SELECT count(*) n FROM source_resources"),
      transactions:num("SELECT count(*) n FROM transactions"),
      projects:num("SELECT count(*) n FROM projects"),
      observations:num("SELECT count(*) n FROM observations"),
      snapshots:num("SELECT count(*) n FROM raw_snapshots")
    });
    if(url.pathname==="/api/transactions"){
      const type=url.searchParams.get("type");
      const source=url.searchParams.get("source");
      const limit=Math.min(Number(url.searchParams.get("limit") ?? 100),1000);
      const clauses:string[]=[]; const params:any[]=[];
      if(type){ clauses.push("transaction_type=?"); params.push(type); }
      if(source){ clauses.push("source_id=?"); params.push(source); }
      const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";
      return json(db.query(`SELECT id,source_id,external_id,transaction_type,occurred_at,amount,currency,title,category,subcategory FROM transactions ${where} ORDER BY occurred_at DESC,id DESC LIMIT ?`).all(...params,limit));
    }
    if(url.pathname==="/api/catalog"){
      const q=url.searchParams.get("q")?.trim();
      const limit=Math.min(Number(url.searchParams.get("limit") ?? 100),500);
      if(q) return json(db.query(`SELECT * FROM source_catalog_items WHERE title LIKE ? OR description LIKE ? ORDER BY updated_at DESC LIMIT ?`).all(`%${q}%`,`%${q}%`,limit));
      return json(db.query(`SELECT * FROM source_catalog_items ORDER BY updated_at DESC LIMIT ?`).all(limit));
    }
    if(url.pathname==="/api/runs") return json(db.query(`SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 100`).all());

    const filePath=url.pathname==="/"?"public/index.html":`public${url.pathname}`;
    const file=Bun.file(filePath);
    if(await file.exists()) return new Response(file);
    return new Response("Not found",{status:404});
  }
});
console.log(`Chile Transparente: http://localhost:${server.port}`);
