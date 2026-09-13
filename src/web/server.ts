import { initDb, db } from "../db";
import { SOURCES } from "../domain/sources";

await initDb();
const port=Number(process.env.PORT ?? 3000);

function json(data:unknown,status=200){ return Response.json(data,{status,headers:{"cache-control":"no-store"}}); }
function num(q:string,...params:any[]){ return Number((db.query(q).get(...params) as any)?.n ?? 0); }
function rows(q:string,...params:any[]){ return db.query(q).all(...params) as any[]; }

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
    const obs=db.query(`SELECT observed_at,value_number,value_text,unit FROM observations WHERE source_id='bcentral' AND metric=? ORDER BY observed_at DESC,id DESC LIMIT 1`).get(metric.external_id) as any;
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
  const totalResources=num(`SELECT count(*) n FROM source_resources`);
  const doneResources=num(`SELECT count(*) n FROM source_resources WHERE sync_status IN ('parsed','downloaded','unsupported')`);
  const bRun=latestRun('bcentral'); const dRun=latestRun('datos-gob'); const cRun=latestRun('chilecompra');
  const metrics=num(`SELECT count(*) n FROM metric_definitions WHERE source_id='bcentral'`);
  const shapes=num(`SELECT count(*) n FROM geo_areas WHERE source_id='ide-chile' AND geometry_json IS NOT NULL`);
  const areas=num(`SELECT count(*) n FROM geo_areas WHERE source_id='ide-chile' AND geo_type='region'`);
  return [
    {id:'datos-gob',name:'Datos.gob.cl',current:doneResources,total:totalResources,unit:'recursos',run:dRun},
    {id:'bcentral',name:'Banco Central',current:bRun?.message?.match(/^(\d+)\/(\d+)/)?.[1]?Number(bRun.message.match(/^(\d+)\/(\d+)/)[1]):(bRun?.status==='success'?metrics:0),total:bRun?.message?.match(/^(\d+)\/(\d+)/)?.[2]?Number(bRun.message.match(/^(\d+)\/(\d+)/)[2]):metrics,unit:'series',run:bRun},
    {id:'chilecompra',name:'ChileCompra',current:num(`SELECT count(*) n FROM transactions WHERE source_id='chilecompra'`),total:null,unit:'órdenes',run:cRun},
    {id:'ide-chile',name:'Geografía',current:shapes,total:areas,unit:'regiones',run:null},
  ];
}

const server=Bun.serve({
  port,
  async fetch(req){
    const url=new URL(req.url);
    if(url.pathname==="/api/health") return json({ok:true,time:new Date().toISOString()});
    if(url.pathname==="/api/sources") return json(SOURCES);
    if(url.pathname==="/api/summary") return json({
      sources:num("SELECT count(*) n FROM sources"),catalogItems:num("SELECT count(*) n FROM source_catalog_items"),resources:num("SELECT count(*) n FROM source_resources"),sourceRecords:num("SELECT count(*) n FROM source_records"),transactions:num("SELECT count(*) n FROM transactions"),projects:num("SELECT count(*) n FROM projects"),observations:num("SELECT count(*) n FROM observations"),metrics:num("SELECT count(*) n FROM metric_definitions"),snapshots:num("SELECT count(*) n FROM raw_snapshots"),resourceStatus:Object.fromEntries(rows(`SELECT sync_status,count(*) n FROM source_resources GROUP BY sync_status`).map(r=>[r.sync_status,Number(r.n)]))
    });
    if(url.pathname==="/api/dashboard"){
      const coverage=sourceCoverage();
      const recentRuns=rows(`SELECT id,source_id,started_at,finished_at,status,message,records_seen,records_written FROM ingest_runs ORDER BY id DESC LIMIT 8`);
      const activeRuns=rows(`SELECT id,source_id,started_at,status,message,records_seen,records_written FROM ingest_runs WHERE status='running' ORDER BY id DESC LIMIT 8`);
      return json({
        generatedAt:new Date().toISOString(),
        totals:{sources:num("SELECT count(*) n FROM sources"),populatedSources:coverage.filter(x=>x.active).length,datasets:num("SELECT count(*) n FROM source_catalog_items"),resources:num("SELECT count(*) n FROM source_resources"),sourceRecords:num("SELECT count(*) n FROM source_records"),observations:num("SELECT count(*) n FROM observations"),transactions:num("SELECT count(*) n FROM transactions"),metrics:num("SELECT count(*) n FROM metric_definitions"),snapshots:num("SELECT count(*) n FROM raw_snapshots")},
        economicSeries:latestEconomicSeries(),chileCompra:chileCompraSummary(),sourceCoverage:coverage,connectorProgress:connectorProgress(),recentRuns,activeRuns
      });
    }
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
      if(source) return json(rows(`SELECT m.external_id metric,m.title,m.frequency,m.geo_scope,count(o.id) observations,min(o.observed_at) first_date,max(o.observed_at) last_date FROM metric_definitions m LEFT JOIN observations o ON o.source_id=m.source_id AND o.metric=m.external_id WHERE m.source_id=? GROUP BY m.id ORDER BY m.title LIMIT ?`,source,limit));
      return json(rows(`SELECT * FROM metric_definitions ORDER BY source_id,title LIMIT ?`,limit));
    }
    if(url.pathname==="/api/map/features"){
      const mapRows=rows(`
        SELECT 'transaction' kind,t.id,t.title label,t.category,t.occurred_at date,t.amount value,t.currency unit,g.name geo_name,g.geo_type,g.centroid_lat lat,g.centroid_lon lon
        FROM transactions t JOIN geo_areas g ON g.id=t.geo_area_id
        WHERE g.centroid_lat IS NOT NULL AND g.centroid_lon IS NOT NULL
        UNION ALL
        SELECT 'observation' kind,o.id,COALESCE(m.title,o.metric) label,o.metric category,o.observed_at date,o.value_number value,COALESCE(m.unit,o.unit) unit,g.name geo_name,g.geo_type,g.centroid_lat lat,g.centroid_lon lon
        FROM observations o JOIN geo_areas g ON g.id=o.geo_area_id LEFT JOIN metric_definitions m ON m.source_id=o.source_id AND m.external_id=o.metric
        WHERE g.geo_type!='country' AND g.centroid_lat IS NOT NULL AND g.centroid_lon IS NOT NULL
        ORDER BY date DESC LIMIT 5000`);
      const areas=rows(`SELECT g.id,g.code,g.name,g.geo_type,g.geometry_json,
        (SELECT count(*) FROM transactions t WHERE t.geo_area_id=g.id AND t.source_id='chilecompra') transactions,
        (SELECT COALESCE(sum(t.amount),0) FROM transactions t WHERE t.geo_area_id=g.id AND t.source_id='chilecompra') transaction_amount,
        (SELECT count(*) FROM observations o WHERE o.geo_area_id=g.id) observations
        FROM geo_areas g WHERE g.geometry_json IS NOT NULL`);
      return json({type:"FeatureCollection",features:[...areas.map(r=>({type:"Feature",geometry:JSON.parse(r.geometry_json),properties:{kind:"area",id:r.id,code:r.code,label:r.name,geo_name:r.name,geo_type:r.geo_type,transactions:r.transactions,transaction_amount:r.transaction_amount,observations:r.observations}})),...mapRows.map(r=>({type:"Feature",geometry:{type:"Point",coordinates:[r.lon,r.lat]},properties:{...r,lat:undefined,lon:undefined}}))]});
    }
    if(url.pathname==="/api/geo/areas") return json(rows(`SELECT id,geo_type,code,name,parent_id,centroid_lat,centroid_lon,geometry_json FROM geo_areas ORDER BY geo_type,name LIMIT 10000`));
    if(url.pathname==="/api/runs") return json(rows(`SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 100`));
    const filePath=url.pathname==="/"?"public/index.html":`public${url.pathname}`; const file=Bun.file(filePath); if(await file.exists()) return new Response(file); return new Response("Not found",{status:404});
  }
});
console.log(`Chile Transparente: http://localhost:${server.port}`);
