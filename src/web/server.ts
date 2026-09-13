import { initDb, db } from "../db";
import { SOURCES } from "../domain/sources";

await initDb();
const port=Number(process.env.PORT ?? 3000);

function json(data:unknown,status=200){ return Response.json(data,{status,headers:{"cache-control":"no-store"}}); }
function num(q:string,...params:any[]){ return Number((db.query(q).get(...params) as any)?.n ?? 0); }
function rows(q:string,...params:any[]){ return db.query(q).all(...params) as any[]; }

function latestEconomicSeries(){
  const latest=rows(`SELECT metric,observed_at,value_number,value_text,unit,payload_json FROM observations WHERE source_id='bcentral' ORDER BY observed_at DESC,id DESC LIMIT 1500`);
  const seen=new Set<string>();
  const out:any[]=[];
  for(const r of latest){
    if(seen.has(r.metric)) continue;
    seen.add(r.metric);
    let label=r.metric;
    try{
      const p=JSON.parse(r.payload_json||'{}');
      label=p?.series?.descripEsp || p?.series?.spanishDescription || p?.series?.description || p?.series?.name || r.metric;
    }catch{}
    out.push({metric:r.metric,label,date:r.observed_at,value:r.value_number ?? r.value_text,unit:r.unit});
    if(out.length>=6) break;
  }
  return out;
}

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
      resourceStatus:Object.fromEntries(rows(`SELECT sync_status,count(*) n FROM source_resources GROUP BY sync_status`).map(r=>[r.sync_status,Number(r.n)]))
    });
    if(url.pathname==="/api/dashboard"){
      const resourceStatus=Object.fromEntries(rows(`SELECT sync_status,count(*) n FROM source_resources GROUP BY sync_status`).map(r=>[r.sync_status,Number(r.n)]));
      const spendByCategory=rows(`SELECT COALESCE(category,'Sin categoría') category,COUNT(*) count,SUM(amount) total FROM transactions WHERE amount IS NOT NULL GROUP BY COALESCE(category,'Sin categoría') ORDER BY total DESC LIMIT 6`);
      const projectStatus=rows(`SELECT COALESCE(status,'Sin estado') status,COUNT(*) count FROM projects GROUP BY COALESCE(status,'Sin estado') ORDER BY count DESC LIMIT 6`);
      const recentRuns=rows(`SELECT id,source_id,started_at,finished_at,status,message,records_seen,records_written FROM ingest_runs ORDER BY id DESC LIMIT 6`);
      const activeRuns=rows(`SELECT id,source_id,started_at,status FROM ingest_runs WHERE status='running' ORDER BY id DESC LIMIT 8`);
      return json({
        generatedAt:new Date().toISOString(),
        totals:{
          sources:num("SELECT count(*) n FROM sources"),
          datasets:num("SELECT count(*) n FROM source_catalog_items"),
          resources:num("SELECT count(*) n FROM source_resources"),
          sourceRecords:num("SELECT count(*) n FROM source_records"),
          observations:num("SELECT count(*) n FROM observations"),
          transactions:num("SELECT count(*) n FROM transactions"),
          projects:num("SELECT count(*) n FROM projects"),
          parties:num("SELECT count(*) n FROM political_parties"),
          metrics:num("SELECT count(DISTINCT metric) n FROM observations"),
          snapshots:num("SELECT count(*) n FROM raw_snapshots")
        },
        resourceStatus,
        spendByCategory,
        projectStatus,
        economicSeries:latestEconomicSeries(),
        recentRuns,
        activeRuns
      });
    }
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
      if(source) return json(db.query(`SELECT metric,count(*) observations,min(observed_at) first_date,max(observed_at) last_date FROM observations WHERE source_id=? GROUP BY metric ORDER BY metric LIMIT ?`).all(source,limit));
      return json(db.query(`SELECT source_id,metric,count(*) observations,min(observed_at) first_date,max(observed_at) last_date FROM observations GROUP BY source_id,metric ORDER BY source_id,metric LIMIT ?`).all(limit));
    }
    if(url.pathname==="/api/resources/status") return json(db.query(`SELECT sync_status,count(*) count,sum(record_count) records FROM source_resources GROUP BY sync_status ORDER BY sync_status`).all());
    if(url.pathname==="/api/map/features"){
      const mapRows=rows(`
        SELECT 'transaction' kind,t.id,t.title label,t.category,t.occurred_at date,t.amount value,t.currency unit,g.name geo_name,g.geo_type,g.centroid_lat lat,g.centroid_lon lon
        FROM transactions t JOIN geo_areas g ON g.id=t.geo_area_id
        WHERE g.centroid_lat IS NOT NULL AND g.centroid_lon IS NOT NULL
        UNION ALL
        SELECT 'observation' kind,o.id,o.metric label,o.metric category,o.observed_at date,o.value_number value,o.unit,g.name geo_name,g.geo_type,g.centroid_lat lat,g.centroid_lon lon
        FROM observations o JOIN geo_areas g ON g.id=o.geo_area_id
        WHERE g.centroid_lat IS NOT NULL AND g.centroid_lon IS NOT NULL
        ORDER BY date DESC LIMIT 5000`);
      return json({type:"FeatureCollection",features:mapRows.map(r=>({type:"Feature",geometry:{type:"Point",coordinates:[r.lon,r.lat]},properties:{...r,lat:undefined,lon:undefined}}))});
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
