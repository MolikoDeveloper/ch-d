import { initDb, db } from "../db";
import { SOURCES } from "../domain/sources";

await initDb();
const port=Number(process.env.PORT??3000);
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"cache-control":"no-store"}});
const num=(q:string,...p:any[])=>Number((db.query(q).get(...p)as any)?.n??0);
const rows=(q:string,...p:any[])=>db.query(q).all(...p)as any[];
type CacheEntry={at:number,value:unknown};const cache=new Map<string,CacheEntry>();
function cached<T>(key:string,ttl:number,build:()=>T){const now=Date.now(),hit=cache.get(key);if(hit&&now-hit.at<ttl)return hit.value as T;const value=build();cache.set(key,{at:now,value});return value}

const KEY_SERIES=[
 {key:"uf",label:"Unidad de Fomento (UF)",patterns:["%unidad de fomento%"]},
 {key:"utm",label:"Unidad Tributaria Mensual (UTM)",patterns:["%unidad tributaria mensual%"]},
 {key:"ipc",label:"Índice de Precios al Consumidor (IPC)",patterns:["%indice de precios al consumidor%","%ipc general%"]},
 {key:"usd",label:"Dólar observado",patterns:["%dolar observado%"]},
 {key:"tpm",label:"Tasa de Política Monetaria",patterns:["%politica monetaria%","%tasa de politica monetaria%"]},
 {key:"imacec",label:"IMACEC",patterns:["%imacec%"]},
];
function latestEconomicSeries(){const out:any[]=[],used=new Set<string>();for(const wanted of KEY_SERIES){let metric:any=null;for(const pattern of wanted.patterns){metric=db.query(`SELECT external_id,title,frequency,geo_scope,unit FROM metric_definitions WHERE source_id='bcentral' AND lower(title) LIKE ? ORDER BY length(title),external_id LIMIT 1`).get(pattern)as any;if(metric)break}if(!metric||used.has(metric.external_id))continue;used.add(metric.external_id);const o=db.query(`SELECT observed_at,value_number,value_text,unit FROM observations WHERE source_id='bcentral' AND metric=? ORDER BY observed_at DESC,id DESC LIMIT 1`).get(metric.external_id)as any;if(o)out.push({key:wanted.key,metric:metric.external_id,label:metric.title?.includes('�')?wanted.label:metric.title,date:o.observed_at,value:o.value_number??o.value_text,unit:metric.unit??o.unit,frequency:metric.frequency,geoScope:metric.geo_scope})}return out}
function latestRun(sourceId:string){return db.query(`SELECT id,source_id,started_at,finished_at,status,message,records_seen,records_written FROM ingest_runs WHERE source_id=? ORDER BY id DESC LIMIT 1`).get(sourceId)as any??null}
function chileCompraSummary(){return{orders:num(`SELECT count(*) n FROM transactions WHERE source_id='chilecompra'`),amount:Number((db.query(`SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE source_id='chilecompra'`).get()as any)?.n??0),buyers:num(`SELECT count(DISTINCT tp.organization_id) n FROM transaction_parties tp JOIN transactions t ON t.id=tp.transaction_id WHERE t.source_id='chilecompra' AND tp.role='buyer'`),suppliers:num(`SELECT count(DISTINCT tp.organization_id) n FROM transaction_parties tp JOIN transactions t ON t.id=tp.transaction_id WHERE t.source_id='chilecompra' AND tp.role='supplier'`),byRegion:rows(`SELECT g.name region,count(*) orders,COALESCE(sum(t.amount),0) amount FROM transactions t JOIN geo_areas g ON g.id=t.geo_area_id WHERE t.source_id='chilecompra' GROUP BY g.id,g.name ORDER BY amount DESC LIMIT 8`)}}
function observationSummary(sourceId:string,latest=5){return{metrics:num(`SELECT count(*) n FROM metric_definitions WHERE source_id=?`,sourceId),observations:num(`SELECT count(*) n FROM observations WHERE source_id=?`,sourceId),regional:num(`SELECT count(*) n FROM observations WHERE source_id=? AND geo_area_id IS NOT NULL`,sourceId),latest:rows(`SELECT o.observed_at,o.metric,m.title,o.value_number,g.name region FROM observations o JOIN metric_definitions m ON m.source_id=o.source_id AND m.external_id=o.metric LEFT JOIN geo_areas g ON g.id=o.geo_area_id WHERE o.source_id=? ORDER BY o.id DESC LIMIT ?`,sourceId,latest)}}
function sinimSummary(){return{...observationSummary('sinim'),communes:num(`SELECT count(*) n FROM geo_areas WHERE source_id='sinim' AND geo_type='commune'`)}}
function ineSummary(){return{...observationSummary('ine'),flows:num(`SELECT count(*) n FROM source_catalog_items WHERE source_id='ine'`)}}
function sourceCoverage(){
 const datosResources=num(`SELECT count(*) n FROM source_resources`),datosDone=num(`SELECT count(*) n FROM source_resources WHERE sync_status IN ('parsed','downloaded','unsupported')`),datosRecords=num(`SELECT count(*) n FROM source_records WHERE source_id='datos-gob'`);
 const defs=(id:string)=>num(`SELECT count(*) n FROM metric_definitions WHERE source_id=?`,id),obs=(id:string)=>num(`SELECT count(*) n FROM observations WHERE source_id=?`,id);
 const bcMetrics=defs('bcentral'),bcObs=obs('bcentral'),cc=num(`SELECT count(*) n FROM transactions WHERE source_id='chilecompra'`),energyMetrics=defs('energia-abierta'),energyObs=obs('energia-abierta'),sinimMetrics=defs('sinim'),sinimObs=obs('sinim'),ineMetrics=defs('ine'),ineObs=obs('ine');
 const geoAreas=num(`SELECT count(*) n FROM geo_areas WHERE source_id='ide-chile'`),geoShapes=num(`SELECT count(*) n FROM geo_areas WHERE source_id='ide-chile' AND geometry_json IS NOT NULL`);
 return[
  {id:'datos-gob',name:'Datos.gob.cl',domain:'Catálogo público',records:datosRecords,detail:`${datosDone}/${datosResources} recursos`,active:datosRecords>0||datosDone>0},
  {id:'bcentral',name:'Banco Central',domain:'Economía',records:bcObs,detail:`${bcMetrics} series`,active:bcObs>0||bcMetrics>0},
  {id:'chilecompra',name:'ChileCompra',domain:'Compras públicas',records:cc,detail:`${cc} órdenes`,active:cc>0},
  {id:'energia-abierta',name:'Energía Abierta / CNE',domain:'Energía',records:energyObs,detail:`${energyMetrics} métricas`,active:energyObs>0||energyMetrics>0},
  {id:'sinim',name:'SINIM / SUBDERE',domain:'Municipal',records:sinimObs,detail:`${sinimMetrics} métricas`,active:sinimObs>0||sinimMetrics>0},
  {id:'ine',name:'INE / SIMEL',domain:'Mercado laboral',records:ineObs,detail:`${ineMetrics} métricas`,active:ineObs>0||ineMetrics>0},
  {id:'ide-chile',name:'IDE / geografía',domain:'Territorio',records:geoAreas,detail:`${geoShapes}/${geoAreas} geometrías`,active:geoAreas>0}
 ]
}
function connectorProgress(){
 const resourceCounts=Object.fromEntries(rows(`SELECT sync_status,count(*) n FROM source_resources GROUP BY sync_status`).map(r=>[r.sync_status,Number(r.n)])),total=Object.values(resourceCounts).reduce((a:any,b:any)=>a+Number(b||0),0)as number,done=Number(resourceCounts.parsed||0)+Number(resourceCounts.downloaded||0)+Number(resourceCounts.unsupported||0);
 const b=latestRun('bcentral'),d=latestRun('datos-gob'),c=latestRun('chilecompra'),e=latestRun('energia-abierta'),s=latestRun('sinim'),i=latestRun('ine'),match=b?.message?.match(/^(\d+)\/(\d+)/),metrics=num(`SELECT count(*) n FROM metric_definitions WHERE source_id='bcentral'`),shapes=num(`SELECT count(*) n FROM geo_areas WHERE source_id='ide-chile' AND geometry_json IS NOT NULL`),areas=num(`SELECT count(*) n FROM geo_areas WHERE source_id='ide-chile' AND geo_type='region'`);
 return[
  {id:'datos-gob',name:'Datos.gob.cl',current:done,total,unit:'recursos',run:d},
  {id:'bcentral',name:'Banco Central',current:match?Number(match[1]):(b?.status==='success'?metrics:0),total:match?Number(match[2]):metrics,unit:'series',run:b},
  {id:'chilecompra',name:'ChileCompra',current:num(`SELECT count(*) n FROM transactions WHERE source_id='chilecompra'`),total:null,unit:'órdenes',run:c},
  {id:'energia-abierta',name:'Energía Abierta',current:e?.records_written??num(`SELECT count(*) n FROM observations WHERE source_id='energia-abierta'`),total:null,unit:'observaciones',run:e},
  {id:'sinim',name:'SINIM',current:s?.records_written??num(`SELECT count(*) n FROM observations WHERE source_id='sinim'`),total:null,unit:'observaciones',run:s},
  {id:'ine',name:'INE',current:i?.records_written??num(`SELECT count(*) n FROM observations WHERE source_id='ine'`),total:null,unit:'observaciones',run:i},
  {id:'ide-chile',name:'Geografía',current:shapes,total:areas,unit:'regiones',run:null}
 ]
}
function progressPayload(){return{generatedAt:new Date().toISOString(),connectorProgress:connectorProgress(),recentRuns:rows(`SELECT id,source_id,started_at,finished_at,status,message,records_seen,records_written FROM ingest_runs ORDER BY id DESC LIMIT 10`),activeRuns:rows(`SELECT id,source_id,started_at,status,message,records_seen,records_written FROM ingest_runs WHERE status='running' ORDER BY id DESC LIMIT 10`)}}
function dashboardPayload(){const coverage=sourceCoverage();return{generatedAt:new Date().toISOString(),totals:{sources:num(`SELECT count(*) n FROM sources`),populatedSources:coverage.filter(x=>x.active).length,datasets:num(`SELECT count(*) n FROM source_catalog_items`),resources:num(`SELECT count(*) n FROM source_resources`),sourceRecords:num(`SELECT count(*) n FROM source_records`),observations:num(`SELECT count(*) n FROM observations`),transactions:num(`SELECT count(*) n FROM transactions`),metrics:num(`SELECT count(*) n FROM metric_definitions`),snapshots:num(`SELECT count(*) n FROM raw_snapshots`)},economicSeries:latestEconomicSeries(),chileCompra:chileCompraSummary(),energy:observationSummary('energia-abierta'),sinim:sinimSummary(),ine:ineSummary(),sourceCoverage:coverage}}
function regionalObs(sourceId:string){return rows(`SELECT CASE WHEN g.geo_type='region' THEN g.id WHEN p.geo_type='region' THEN p.id END region_id,COUNT(o.id) observations,COUNT(DISTINCT o.metric) metrics FROM observations o JOIN geo_areas g ON g.id=o.geo_area_id LEFT JOIN geo_areas p ON p.id=g.parent_id WHERE o.source_id=? AND (g.geo_type='region' OR p.geo_type='region') GROUP BY region_id`,sourceId)}
function mapPayload(){
 const purchase=rows(`SELECT g.id,COUNT(t.id) transactions,COALESCE(SUM(t.amount),0) transaction_amount FROM geo_areas g LEFT JOIN transactions t ON t.geo_area_id=g.id AND t.source_id='chilecompra' WHERE g.geo_type='region' GROUP BY g.id`),purchaseMap=new Map(purchase.map(r=>[r.id,r]));
 const maps=Object.fromEntries(['energia-abierta','sinim','ine'].map(id=>[id,new Map(regionalObs(id).map(r=>[r.region_id,r]))]));
 const areas=rows(`SELECT id,code,name,geo_type,geometry_json,centroid_lat,centroid_lon FROM geo_areas WHERE source_id='ide-chile' AND geo_type='region' AND geometry_json IS NOT NULL`);
 const points=rows(`SELECT t.id,t.title label,t.category,t.occurred_at date,t.amount value,t.currency unit,g.name geo_name,g.geo_type,g.centroid_lat lat,g.centroid_lon lon FROM transactions t JOIN geo_areas g ON g.id=t.geo_area_id WHERE t.source_id='chilecompra' AND g.centroid_lat IS NOT NULL AND g.centroid_lon IS NOT NULL ORDER BY t.id DESC LIMIT 500`);
 return{type:'FeatureCollection',features:[...areas.map(r=>{const p=purchaseMap.get(r.id)as any,en=(maps['energia-abierta']as Map<any,any>).get(r.id),si=(maps.sinim as Map<any,any>).get(r.id),ine=(maps.ine as Map<any,any>).get(r.id);return{type:'Feature',geometry:JSON.parse(r.geometry_json),properties:{kind:'area',id:r.id,code:r.code,label:r.name,geo_name:r.name,geo_type:r.geo_type,centroid_lat:r.centroid_lat,centroid_lon:r.centroid_lon,transactions:Number(p?.transactions||0),transaction_amount:Number(p?.transaction_amount||0),energy_observations:Number(en?.observations||0),energy_metrics:Number(en?.metrics||0),sinim_observations:Number(si?.observations||0),sinim_metrics:Number(si?.metrics||0),ine_observations:Number(ine?.observations||0),ine_metrics:Number(ine?.metrics||0)}}}),...points.map(r=>({type:'Feature',geometry:{type:'Point',coordinates:[r.lon,r.lat]},properties:{kind:'transaction',...r,lat:undefined,lon:undefined}}))]}
}

const server=Bun.serve({port,async fetch(req){
 const url=new URL(req.url);
 if(url.pathname==="/api/health")return json({ok:true,time:new Date().toISOString()});
 if(url.pathname==="/api/sources")return json(SOURCES);
 if(url.pathname==="/api/progress")return json(progressPayload());
 if(url.pathname==="/api/dashboard")return json(cached('dashboard',60000,dashboardPayload));
 if(url.pathname==="/api/summary")return json(cached('summary',60000,()=>({sources:num(`SELECT count(*) n FROM sources`),catalogItems:num(`SELECT count(*) n FROM source_catalog_items`),resources:num(`SELECT count(*) n FROM source_resources`),sourceRecords:num(`SELECT count(*) n FROM source_records`),transactions:num(`SELECT count(*) n FROM transactions`),projects:num(`SELECT count(*) n FROM projects`),observations:num(`SELECT count(*) n FROM observations`),metrics:num(`SELECT count(*) n FROM metric_definitions`),snapshots:num(`SELECT count(*) n FROM raw_snapshots`)})));
 if(url.pathname==="/api/transactions"){const source=url.searchParams.get("source"),limit=Math.min(Number(url.searchParams.get("limit")??100),1000);return source?json(rows(`SELECT * FROM transactions WHERE source_id=? ORDER BY occurred_at DESC,id DESC LIMIT ?`,source,limit)):json(rows(`SELECT * FROM transactions ORDER BY occurred_at DESC,id DESC LIMIT ?`,limit))}
 if(url.pathname==="/api/observations"){const source=url.searchParams.get("source"),metric=url.searchParams.get("metric"),from=url.searchParams.get("from"),to=url.searchParams.get("to"),limit=Math.min(Number(url.searchParams.get("limit")??200),5000),clauses:string[]=[],params:any[]=[];if(source){clauses.push("o.source_id=?");params.push(source)}if(metric){clauses.push("o.metric=?");params.push(metric)}if(from){clauses.push("o.observed_at>=?");params.push(from)}if(to){clauses.push("o.observed_at<=?");params.push(to)}const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";return json(rows(`SELECT o.id,o.source_id,o.external_id,o.observed_at,o.metric,COALESCE(m.title,o.metric) metric_title,o.value_number,o.value_text,COALESCE(m.unit,o.unit) unit,o.geo_area_id FROM observations o LEFT JOIN metric_definitions m ON m.source_id=o.source_id AND m.external_id=o.metric ${where} ORDER BY o.observed_at DESC,o.id DESC LIMIT ?`,...params,limit))}
 if(url.pathname==="/api/metrics"){const source=url.searchParams.get("source"),limit=Math.min(Number(url.searchParams.get("limit")??500),5000);return source?json(rows(`SELECT external_id metric,title,frequency,geo_scope,unit FROM metric_definitions WHERE source_id=? ORDER BY title LIMIT ?`,source,limit)):json(rows(`SELECT * FROM metric_definitions ORDER BY source_id,title LIMIT ?`,limit))}
 if(url.pathname==="/api/map/features")return json(cached('map',300000,mapPayload));
 if(url.pathname==="/api/geo/areas")return json(cached('areas',300000,()=>rows(`SELECT id,geo_type,code,name,parent_id,centroid_lat,centroid_lon,geometry_json FROM geo_areas ORDER BY geo_type,name LIMIT 10000`)));
 if(url.pathname==="/api/runs")return json(rows(`SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 100`));
 const path=url.pathname==="/"?"public/index.html":`public${url.pathname}`,file=Bun.file(path);if(await file.exists())return new Response(file);return new Response("Not found",{status:404});
}});
console.log(`Chile Transparente: http://localhost:${server.port}`);
