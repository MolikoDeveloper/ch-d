import { initDb, db } from "../db";
import { SOURCES } from "../domain/sources";

await initDb();
const port=Number(process.env.PORT ?? 3000);

function json(data:unknown,status=200){ return Response.json(data,{status,headers:{"cache-control":"no-store"}}); }
function num(q:string,...params:any[]){ return Number((db.query(q).get(...params) as any)?.n ?? 0); }
function rows(q:string,...params:any[]){ return db.query(q).all(...params) as any[]; }

type CacheEntry={at:number,value:unknown};
const cache=new Map<string,CacheEntry>();
function cached<T>(key:string,ttlMs:number,build:()=>T):T{
  const now=Date.now(),hit=cache.get(key);
  if(hit&&now-hit.at<ttlMs) return hit.value as T;
  const value=build(); cache.set(key,{at:now,value}); return value;
}

const KEY_SERIES=[
  {key:"uf",label:"Unidad de Fomento (UF)",patterns:["%unidad de fomento%"]},
  {key:"utm",label:"Unidad Tributaria Mensual (UTM)",patterns:["%unidad tributaria mensual%"]},
  {key:"ipc",label:"Índice de Precios al Consumidor (IPC)",patterns:["%indice de precios al consumidor%","%ipc general%"]},
  {key:"usd",label:"Dólar observado",patterns:["%dolar observado%"]},
  {key:"tpm",label:"Tasa de Política Monetaria",patterns:["%politica monetaria%","%tasa de politica monetaria%"]},
  {key:"imacec",label:"IMACEC",patterns:["%imacec%"]},
];

function latestEconomicSeries(){
  const out:any[]=[]; const used=new Set<string>();
  for(const wanted of KEY_SERIES){
    let metric:any=null;
    for(const pattern of wanted.patterns){
      metric=db.query(`SELECT external_id,title,frequency,geo_scope,unit FROM metric_definitions WHERE source_id='bcentral' AND lower(title) LIKE ? ORDER BY length(title),external_id LIMIT 1`).get(pattern) as any;
      if(metric) break;
    }
    if(!metric||used.has(metric.external_id)) continue;
    used.add(metric.external_id);
    const obs=db.query(`SELECT observed_at,value_number,value_text,unit FROM observations WHERE metric=? ORDER BY observed_at DESC,id DESC LIMIT 1`).get(metric.external_id) as any;
    if(!obs) continue;
    out.push({key:wanted.key,metric:metric.external_id,label:metric.title?.includes('�')?wanted.label:metric.title,date:obs.observed_at,value:obs.value_number??obs.value_text,unit:metric.unit??obs.unit,frequency:metric.frequency,geoScope:metric.geo_scope});
  }
  return out;
}

function latestRun(sourceId:string){return db.query(`SELECT id,source_id,started_at,finished_at,status,message,records_seen,records_written FROM ingest_runs WHERE source_id=? ORDER BY id DESC LIMIT 1`).get(sourceId) as any ?? null;}

function chileCompraSummary(){
  return {
    orders:num(`SELECT count(*) n FROM transactions WHERE source_id='chilecompra'`),
    amount:Number((db.query(`SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE source_id='chilecompra'`).get() as any)?.n ?? 0),
    buyers:num(`SELECT count(DISTINCT tp.organization_id) n FROM transaction_parties tp JOIN transactions t ON t.id=tp.transaction_id WHERE t.source_id='chilecompra' AND tp.role='buyer'`),
    suppliers:num(`SELECT count(DISTINCT tp.organization_id) n FROM transaction_parties tp JOIN transactions t ON t.id=tp.transaction_id WHERE t.source_id='chilecompra' AND tp.role='supplier'`),
    byRegion:rows(`SELECT g.name region,count(*) orders,COALESCE(sum(t.amount),0) amount FROM transactions t JOIN geo_areas g ON g.id=t.geo_area_id WHERE t.source_id='chilecompra' GROUP BY g.id,g.name ORDER BY amount DESC LIMIT 8`),
    recent:rows(`SELECT external_id,occurred_at,title,amount,currency FROM transactions WHERE source_id='chilecompra' ORDER BY occurred_at DESC,id DESC LIMIT 5`)
  };
}

function sourceCoverage(){
  const datosResources=num(`SELECT count(*) n FROM source_resources`);
  const datosDone=num(`SELECT count(*) n FROM source_resources WHERE sync_status IN ('parsed','downloaded','unsupported')`);
  const datosRecords=num(`SELECT count(*) n FROM source_records WHERE source_id='datos-gob'`);
  const bcMetrics=num(`SELECT count(*) n FROM metric_definitions WHERE source_id='bcentral'`);
  const bcObs=num(`SELECT count(*) n FROM observations WHERE source_id='bcentral'`);
  const ccOrders=num(`SELECT count(*) n FROM transactions WHERE source_id='chilecompra'`);
  const geoAreas=num(`SELECT count(*) n FROM geo_areas WHERE source_id='ide-chile'`);
  const geoShapes=num(`SELECT count(*) n FROM geo_areas WHERE source_id='ide-chile' AND geometry_json IS NOT NULL`);
  return [
    {id:'datos-gob',name:'Datos.gob.cl',domain:'Catálogo público',records:datosRecords,detail:`${datosDone}/${datosResources} recursos`,active:datosRecords>0||datosDone>0},
    {id:'bcentral',name:'Banco Central',domain:'Economía',records:bcObs,detail:`${bcMetrics} series`,active:bcObs>0||bcMetrics>0},
    {id:'chilecompra',name:'ChileCompra',domain:'Compras públicas',records:ccOrders,detail:`${ccOrders} órdenes`,active:ccOrders>0},
    {id:'ide-chile',name:'IDE / geografía',domain:'Territorio',records:geoAreas,detail:`${geoShapes}/${geoAreas} geometrías`,active:geoAreas>0},
  ];
}

function connectorProgress(){
  const resourceCounts=Object.fromEntries(rows(`SELECT sync_status,count(*) n FROM source_resources GROUP BY sync_status`).map(r=>[r.sync_status,Number(r.n)]));
  const totalResources=Object.values(resourceCounts).reduce((a:any,b:any)=>a+Number(b||0),0) as number;
  const doneResources=Number(resourceCounts.parsed||0)+Number(resourceCounts.downloaded||0)+Number(resourceCounts.unsupported||0);
  const bRun=latestRun('bcentral'),dRun=latestRun('datos-gob'),cRun=latestRun('chilecompra');
  const metrics=num(`SELECT count(*) n FROM metric_definitions WHERE source_id='bcentral'`);
  const shapes=num(`SELECT count(*) n FROM geo_areas WHERE source_id='ide-chile' AND geometry_json IS NOT NULL`);
  const areas=num(`SELECT count(*) n FROM geo_areas WHERE source_id='ide-chile' AND geo_type='region'`);
  const match=bRun?.message?.match(/^(\d+)\/(\d+)/);
  return [
    {id:'datos-gob',name:'Datos.gob.cl',current:doneResources,total:totalResources,unit:'recursos',run:dRun},
    {id:'bcentral',name:'Banco Central',current:match?Number(match[1]):(bRun?.status==='success'?metrics:0),total:match?Number(match[2]):metrics,unit:'series',run:bRun},
    {id:'chilecompra',name:'ChileCompra',current:num(`SELECT count(*) n FROM transactions WHERE source_id='chilecompra'`),total:null,unit:'órdenes',run:cRun},
    {id:'ide-chile',name:'Geografía',current:shapes,total:areas,unit:'regiones',run:null},
  ];
}

function progressPayload(){
  return {
    generatedAt:new Date().toISOString(),
    connectorProgress:connectorProgress(),
    recentRuns:rows(`SELECT id,source_id,started_at,finished_at,status,message,records_seen,records_written FROM ingest_runs ORDER BY id DESC LIMIT 8`),
    activeRuns:rows(`SELECT id,source_id,started_at,status,message,records_seen,records_written FROM ingest_runs WHERE status='running' ORDER BY id DESC LIMIT 8`)
  };
}

function dashboardPayload(){
  const coverage=sourceCoverage();
  return {
    generatedAt:new Date().toISOString(),
    totals:{
      sources:num("SELECT count(*) n FROM sources"),
      populatedSources:coverage.filter(x=>x.active).length,
      datasets:num("SELECT count(*) n FROM source_catalog_items"),
      resources:num("SELECT count(*) n FROM source_resources"),
      sourceRecords:num("SELECT count(*) n FROM source_records"),
      observations:num("SELECT count(*) n FROM observations"),
      transactions:num("SELECT count(*) n FROM transactions"),
      metrics:num("SELECT count(*) n FROM metric_definitions"),
      snapshots:num("SELECT count(*) n FROM raw_snapshots")
    },
    economicSeries:latestEconomicSeries(),
    chileCompra:chileCompraSummary(),
    sourceCoverage:coverage
  };
}

function mapPayload(){
  const regionStats=rows(`SELECT g.id,g.name,COUNT(t.id) transactions,COALESCE(SUM(t.amount),0) transaction_amount
    FROM geo_areas g LEFT JOIN transactions t ON t.geo_area_id=g.id AND t.source_id='chilecompra'
    WHERE g.geo_type='region' GROUP BY g.id,g.name`);
  const stats=new Map(regionStats.map(r=>[r.id,r]));
  const areas=rows(`SELECT id,code,name,geo_type,geometry_json FROM geo_areas WHERE geometry_json IS NOT NULL`);
  const points=rows(`SELECT t.id,t.title label,t.category,t.occurred_at date,t.amount value,t.currency unit,g.name geo_name,g.geo_type,g.centroid_lat lat,g.centroid_lon lon
    FROM transactions t JOIN geo_areas g ON g.id=t.geo_area_id
    WHERE t.source_id='chilecompra' AND g.centroid_lat IS NOT NULL AND g.centroid_lon IS NOT NULL
    ORDER BY t.id DESC LIMIT 500`);
  return {type:'FeatureCollection',features:[
    ...areas.map(r=>{const s=stats.get(r.id) as any;return {type:'Feature',geometry:JSON.parse(r.geometry_json),properties:{kind:'area',id:r.id,code:r.code,label:r.name,geo_name:r.name,geo_type:r.geo_type,transactions:Number(s?.transactions||0),transaction_amount:Number(s?.transaction_amount||0)}}}),
    ...points.map(r=>({type:'Feature',geometry:{type:'Point',coordinates:[r.lon,r.lat]},properties:{kind:'transaction',...r,lat:undefined,lon:undefined}}))
  ]};
}

const server=Bun.serve({
  port,
  async fetch(req){
    const url=new URL(req.url);
    if(url.pathname==="/api/health") return json({ok:true,time:new Date().toISOString()});
    if(url.pathname==="/api/sources") return json(SOURCES);
    if(url.pathname==="/api/progress") return json(progressPayload());
    if(url.pathname==="/api/summary") return json(cached('summary',60000,()=>({
      sources:num("SELECT count(*) n FROM sources"),catalogItems:num("SELECT count(*) n FROM source_catalog_items"),resources:num("SELECT count(*) n FROM source_resources"),sourceRecords:num("SELECT count(*) n FROM source_records"),transactions:num("SELECT count(*) n FROM transactions"),projects:num("SELECT count(*) n FROM projects"),observations:num("SELECT count(*) n FROM observations"),metrics:num("SELECT count(*) n FROM metric_definitions"),snapshots:num("SELECT count(*) n FROM raw_snapshots"),resourceStatus:Object.fromEntries(rows(`SELECT sync_status,count(*) n FROM source_resources GROUP BY sync_status`).map(r=>[r.sync_status,Number(r.n)]))
    })));
    if(url.pathname==="/api/dashboard") return json(cached('dashboard',60000,dashboardPayload));
    if(url.pathname==="/api/transactions"){
      const source=url.searchParams.get("source"); const limit=Math.min(Number(url.searchParams.get("limit") ?? 100),1000);
      return source?json(rows(`SELECT * FROM transactions WHERE source_id=? ORDER BY occurred_at DESC,id DESC LIMIT ?`,source,limit)):json(rows(`SELECT * FROM transactions ORDER BY occurred_at DESC,id DESC LIMIT ?`,limit));
    }
    if(url.pathname==="/api/observations"){
      const source=url.searchParams.get("source"),metric=url.searchParams.get("metric"),from=url.searchParams.get("from"),to=url.searchParams.get("to");
      const limit=Math.min(Number(url.searchParams.get("limit") ?? 200),5000); const clauses:string[]=[]; const params:any[]=[];
      if(source){ clauses.push("o.source_id=?"); params.push(source); } if(metric){ clauses.push("o.metric=?"); params.push(metric); } if(from){ clauses.push("o.observed_at>=?"); params.push(from); } if(to){ clauses.push("o.observed_at<=?"); params.push(to); }
      const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";
      return json(rows(`SELECT o.id,o.source_id,o.external_id,o.observed_at,o.metric,COALESCE(m.title,o.metric) metric_title,o.value_number,o.value_text,COALESCE(m.unit,o.unit) unit,o.geo_area_id FROM observations o LEFT JOIN metric_definitions m ON m.source_id=o.source_id AND m.external_id=o.metric ${where} ORDER BY o.observed_at DESC,o.id DESC LIMIT ?`,...params,limit));
    }
    if(url.pathname==="/api/metrics"){
      const source=url.searchParams.get("source"); const limit=Math.min(Number(url.searchParams.get("limit") ?? 500),5000);
      if(source) return json(rows(`SELECT external_id metric,title,frequency,geo_scope,unit FROM metric_definitions WHERE source_id=? ORDER BY title LIMIT ?`,source,limit));
      return json(rows(`SELECT * FROM metric_definitions ORDER BY source_id,title LIMIT ?`,limit));
    }
    if(url.pathname==="/api/map/features") return json(cached('map',300000,mapPayload));
    if(url.pathname==="/api/geo/areas") return json(cached('areas',300000,()=>rows(`SELECT id,geo_type,code,name,parent_id,centroid_lat,centroid_lon,geometry_json FROM geo_areas ORDER BY geo_type,name LIMIT 10000`)));
    if(url.pathname==="/api/runs") return json(rows(`SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 100`));
    const filePath=url.pathname==="/"?"public/index.html":`public${url.pathname}`; const file=Bun.file(filePath); if(await file.exists()) return new Response(file); return new Response("Not found",{status:404});
  }
});
console.log(`Chile Transparente: http://localhost:${server.port}`);
