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
      sourceRecords:num("SELECT count(*) n FROM source_records"),
      transactions:num("SELECT count(*) n FROM transactions"),
      projects:num("SELECT count(*) n FROM projects"),
      observations:num("SELECT count(*) n FROM observations"),
      snapshots:num("SELECT count(*) n FROM raw_snapshots"),
      resourceStatus:Object.fromEntries((db.query(`SELECT sync_status,count(*) n FROM source_resources GROUP BY sync_status`).all() as any[]).map(r=>[r.sync_status,Number(r.n)]))
    });
    if(url.pathname==="/api/transactions"){
      const type=url.searchParams.get("type");
      const source=url.searchParams.get("source");
      const limit=Math.min(Number(url.searchParams.get("limit") ?? 100),1000);
      const clauses:string[]=[]; const params:any[]=[];
      if(type){ clauses.push("transaction_type=?"); params.push(type); }
      if(source){ clauses.push("source_id=?"); params.push(source); }
      const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";
      return json(db.query(`SELECT id,source_id,external_id,transaction_type,occurred_at,amount,currency,title,category,subcategory,geo_area_id FROM transactions ${where} ORDER BY occurred_at DESC,id DESC LIMIT ?`).all(...params,limit));
    }
    if(url.pathname==="/api/observations"){
      const source=url.searchParams.get("source");
      const metric=url.searchParams.get("metric");
      const from=url.searchParams.get("from");
      const to=url.searchParams.get("to");
      const limit=Math.min(Number(url.searchParams.get("limit") ?? 200),5000);
      const clauses:string[]=[]; const params:any[]=[];
      if(source){ clauses.push("source_id=?"); params.push(source); }
      if(metric){ clauses.push("metric=?"); params.push(metric); }
      if(from){ clauses.push("observed_at>=?"); params.push(from); }
      if(to){ clauses.push("observed_at<=?"); params.push(to); }
      const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";
      return json(db.query(`SELECT id,source_id,external_id,observed_at,metric,value_number,value_text,unit,subject_type,subject_id,geo_area_id FROM observations ${where} ORDER BY observed_at DESC,id DESC LIMIT ?`).all(...params,limit));
    }
    if(url.pathname==="/api/metrics"){
      const source=url.searchParams.get("source");
      const limit=Math.min(Number(url.searchParams.get("limit") ?? 500),5000);
      if(source){
        return json(db.query(`SELECT metric,count(*) observations,min(observed_at) first_date,max(observed_at) last_date FROM observations WHERE source_id=? GROUP BY metric ORDER BY metric LIMIT ?`).all(source,limit));
      }
      return json(db.query(`SELECT source_id,metric,count(*) observations,min(observed_at) first_date,max(observed_at) last_date FROM observations GROUP BY source_id,metric ORDER BY source_id,metric LIMIT ?`).all(limit));
    }
    if(url.pathname==="/api/resources/status") return json(db.query(`SELECT sync_status,count(*) count,sum(record_count) records FROM source_resources GROUP BY sync_status ORDER BY sync_status`).all());
    if(url.pathname==="/api/map/features"){
      const rows=db.query(`
        SELECT 'transaction' kind,t.id,t.title label,t.category,t.occurred_at date,t.amount value,t.currency unit,g.name geo_name,g.geo_type,g.centroid_lat lat,g.centroid_lon lon
        FROM transactions t JOIN geo_areas g ON g.id=t.geo_area_id
        WHERE g.centroid_lat IS NOT NULL AND g.centroid_lon IS NOT NULL
        UNION ALL
        SELECT 'observation' kind,o.id,o.metric label,o.metric category,o.observed_at date,o.value_number value,o.unit,g.name geo_name,g.geo_type,g.centroid_lat lat,g.centroid_lon lon
        FROM observations o JOIN geo_areas g ON g.id=o.geo_area_id
        WHERE g.centroid_lat IS NOT NULL AND g.centroid_lon IS NOT NULL
        ORDER BY date DESC LIMIT 5000`).all() as any[];
      return json({type:"FeatureCollection",features:rows.map(r=>({type:"Feature",geometry:{type:"Point",coordinates:[r.lon,r.lat]},properties:{...r,lat:undefined,lon:undefined}}))});
    }
    if(url.pathname==="/api/geo/areas") return json(db.query(`SELECT id,geo_type,code,name,parent_id,centroid_lat,centroid_lon,geometry_json FROM geo_areas ORDER BY geo_type,name LIMIT 10000`).all());
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
