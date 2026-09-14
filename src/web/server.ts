import { initDb, db } from "../db";
import { SOURCES } from "../domain/sources";
import { communeProfile, indicatorCatalog, indicatorMap, searchPublicData, territoriesPayload } from "./explorer";

await initDb();
const port=Number(process.env.PORT??3000);
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"cache-control":"no-store"}});
const rows=(q:string,...p:any[])=>db.query(q).all(...p) as any[];
const one=(q:string,...p:any[])=>db.query(q).get(...p) as any|null;
const count=(q:string,...p:any[])=>Number(one(q,...p)?.n??0);

type CacheEntry={at:number,value:unknown};
const cache=new Map<string,CacheEntry>();
function cached<T>(key:string,ttl:number,build:()=>T):T{const now=Date.now(),hit=cache.get(key);if(hit&&now-hit.at<ttl)return hit.value as T;const value=build();cache.set(key,{at:now,value});return value}
function norm(v:string){return v.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim()}

const ECONOMY=[
  {key:"uf",label:"Unidad de Fomento (UF)",patterns:["unidad de fomento"]},
  {key:"utm",label:"Unidad Tributaria Mensual (UTM)",patterns:["unidad tributaria mensual"]},
  {key:"ipc",label:"IPC",patterns:["indice de precios al consumidor","ipc general"]},
  {key:"usd",label:"Dólar observado",patterns:["dolar observado"]},
  {key:"tpm",label:"Tasa de Política Monetaria",patterns:["tasa de politica monetaria","politica monetaria"]},
  {key:"imacec",label:"IMACEC",patterns:["imacec"]},
];
function economyFacts(){
  const defs=rows(`SELECT external_id,title,unit,frequency FROM metric_definitions WHERE source_id='bcentral'`);
  const out:any[]=[];const used=new Set<string>();
  for(const spec of ECONOMY){
    let metric:any=null;
    for(const p of spec.patterns){const n=norm(p);metric=defs.filter(d=>norm(d.title).includes(n)).sort((a,b)=>a.title.length-b.title.length)[0];if(metric)break}
    if(!metric||used.has(metric.external_id))continue;used.add(metric.external_id);
    const o=one(`SELECT observed_at,value_number,value_text,unit FROM observations WHERE source_id='bcentral' AND metric=? ORDER BY observed_at DESC,id DESC LIMIT 1`,metric.external_id);
    if(o)out.push({key:spec.key,label:spec.label,title:metric.title,metric:metric.external_id,value:o.value_number??o.value_text,unit:metric.unit??o.unit,date:o.observed_at,source:"Banco Central de Chile"});
  }
  return out;
}
function purchaseSummary(){return{
  source:"ChileCompra / Mercado Público",
  orders:count(`SELECT count(*) n FROM transactions WHERE source_id='chilecompra'`),
  amount:Number(one(`SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE source_id='chilecompra'`)?.n??0),
  buyers:count(`SELECT count(DISTINCT tp.organization_id) n FROM transaction_parties tp JOIN transactions t ON t.id=tp.transaction_id WHERE t.source_id='chilecompra' AND tp.role='buyer'`),
  suppliers:count(`SELECT count(DISTINCT tp.organization_id) n FROM transaction_parties tp JOIN transactions t ON t.id=tp.transaction_id WHERE t.source_id='chilecompra' AND tp.role='supplier'`),
  latestDate:one(`SELECT max(occurred_at) d FROM transactions WHERE source_id='chilecompra'`)?.d??null,
};}
function panoramaPayload(){return{
  generatedAt:new Date().toISOString(),
  economy:economyFacts(),
  purchases:purchaseSummary(),
  territory:{regions:count(`SELECT count(*) n FROM geo_areas WHERE source_id='ide-chile' AND geo_type='region'`),communes:count(`SELECT count(*) n FROM geo_areas WHERE source_id='sinim' AND geo_type='commune'`),mayors:count(`SELECT count(*) n FROM relationships WHERE source_id='sinim' AND relation_type='mayor'`),councillors:count(`SELECT count(*) n FROM relationships WHERE source_id='sinim' AND relation_type='councillor'`)},
};}

function progressPayload(){
  const latest=(id:string)=>one(`SELECT id,source_id,started_at,finished_at,status,message,records_seen,records_written FROM ingest_runs WHERE source_id=? ORDER BY id DESC LIMIT 1`,id);
  const resourceCounts=Object.fromEntries(rows(`SELECT sync_status,count(*) n FROM source_resources GROUP BY sync_status`).map(r=>[r.sync_status,Number(r.n)]));
  const total=Object.values(resourceCounts).reduce((a:any,b:any)=>a+Number(b||0),0) as number;
  const done=Number(resourceCounts.parsed||0)+Number(resourceCounts.downloaded||0)+Number(resourceCounts.unsupported||0);
  const ids=["bcentral","chilecompra","energia-abierta","sinim","ine"];
  return{
    generatedAt:new Date().toISOString(),
    connectorProgress:[{id:"datos-gob",name:"Datos.gob.cl",current:done,total,unit:"recursos",run:latest("datos-gob")},...ids.map(id=>{const run=latest(id);return{id,name:id,current:Number(run?.records_written??0),total:null,unit:"registros",run}})],
    recentRuns:rows(`SELECT id,source_id,started_at,finished_at,status,message,records_seen,records_written FROM ingest_runs ORDER BY id DESC LIMIT 20`),
    activeRuns:rows(`SELECT id,source_id,started_at,status,message,records_seen,records_written FROM ingest_runs WHERE status='running' ORDER BY id DESC LIMIT 20`),
  };
}

function regionMapPayload(){
  const purchaseRows=rows(`SELECT g.id region_id,COUNT(t.id) orders,COALESCE(SUM(t.amount),0) amount FROM geo_areas g LEFT JOIN transactions t ON t.geo_area_id=g.id AND t.source_id='chilecompra' WHERE g.source_id='ide-chile' AND g.geo_type='region' GROUP BY g.id`);
  const purchases=new Map(purchaseRows.map(r=>[r.region_id,r]));
  const areas=rows(`SELECT id,code,name,geometry_json,centroid_lat,centroid_lon FROM geo_areas WHERE source_id='ide-chile' AND geo_type='region' AND geometry_json IS NOT NULL ORDER BY CAST(code AS INTEGER)`);
  return{type:"FeatureCollection",features:areas.map(r=>{const p:any=purchases.get(r.id);return{type:"Feature",geometry:JSON.parse(r.geometry_json),properties:{id:r.id,code:r.code,name:r.name,centroid_lat:r.centroid_lat,centroid_lon:r.centroid_lon,purchases:{amount:Number(p?.amount||0),orders:Number(p?.orders||0)}}}})};
}

const server=Bun.serve({port,async fetch(req){
  const url=new URL(req.url);
  if(url.pathname==="/api/health")return json({ok:true,time:new Date().toISOString()});
  if(url.pathname==="/api/sources")return json(SOURCES);
  if(url.pathname==="/api/dashboard"||url.pathname==="/api/panorama")return json(cached("panorama",300000,panoramaPayload));
  if(url.pathname==="/api/progress")return json(progressPayload());
  if(url.pathname==="/api/map/features"||url.pathname==="/api/map/regions")return json(cached("regions",300000,regionMapPayload));

  if(url.pathname==="/api/explorer/territories")return json(cached("territories",300000,territoriesPayload));
  if(url.pathname==="/api/explorer/commune"){const code=url.searchParams.get("code")??"";const data=communeProfile(code);return data?json(data):json({error:"Comuna no encontrada"},404)}
  if(url.pathname==="/api/explorer/metrics"){const source=url.searchParams.get("source")??"sinim";return json(cached(`metrics:${source}`,300000,()=>indicatorCatalog(source)))}
  if(url.pathname==="/api/explorer/map"){const source=url.searchParams.get("source")??"sinim",metric=url.searchParams.get("metric")??"";const data=indicatorMap(source,metric);return data?json(data):json({error:"Indicador no encontrado"},404)}
  if(url.pathname==="/api/explorer/search"){const q=url.searchParams.get("q")??"";return json(searchPublicData(q,Math.min(100,Number(url.searchParams.get("limit")??50))))}

  if(url.pathname==="/api/transactions"){const source=url.searchParams.get("source"),limit=Math.min(Number(url.searchParams.get("limit")??100),1000);return source?json(rows(`SELECT * FROM transactions WHERE source_id=? ORDER BY occurred_at DESC,id DESC LIMIT ?`,source,limit)):json(rows(`SELECT * FROM transactions ORDER BY occurred_at DESC,id DESC LIMIT ?`,limit))}
  if(url.pathname==="/api/observations"){
    const source=url.searchParams.get("source"),metric=url.searchParams.get("metric"),geo=url.searchParams.get("geo"),from=url.searchParams.get("from"),to=url.searchParams.get("to"),limit=Math.min(Number(url.searchParams.get("limit")??200),5000),clauses:string[]=[],params:any[]=[];
    if(source){clauses.push("o.source_id=?");params.push(source)}if(metric){clauses.push("o.metric=?");params.push(metric)}if(geo){clauses.push("o.geo_area_id=?");params.push(Number(geo))}if(from){clauses.push("o.observed_at>=?");params.push(from)}if(to){clauses.push("o.observed_at<=?");params.push(to)}const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";
    return json(rows(`SELECT o.id,o.source_id,o.external_id,o.observed_at,o.metric,COALESCE(m.title,o.metric) metric_title,o.value_number,o.value_text,COALESCE(m.unit,o.unit) unit,o.geo_area_id,g.name territory FROM observations o LEFT JOIN metric_definitions m ON m.source_id=o.source_id AND m.external_id=o.metric LEFT JOIN geo_areas g ON g.id=o.geo_area_id ${where} ORDER BY o.observed_at DESC,o.id DESC LIMIT ?`,...params,limit));
  }
  if(url.pathname==="/api/metrics"){const source=url.searchParams.get("source"),limit=Math.min(Number(url.searchParams.get("limit")??500),10000);return source?json(rows(`SELECT external_id metric,title,subcategory,frequency,geo_scope,unit FROM metric_definitions WHERE source_id=? ORDER BY COALESCE(subcategory,''),title LIMIT ?`,source,limit)):json(rows(`SELECT * FROM metric_definitions ORDER BY source_id,title LIMIT ?`,limit))}
  if(url.pathname==="/api/geo/areas")return json(cached("areas",300000,()=>rows(`SELECT id,geo_type,code,name,parent_id,centroid_lat,centroid_lon,geometry_json FROM geo_areas ORDER BY geo_type,name LIMIT 10000`)));
  if(url.pathname==="/api/runs")return json(rows(`SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 100`));

  const path=url.pathname==="/"?"public/index.html":`public${url.pathname}`;const file=Bun.file(path);if(await file.exists())return new Response(file);return new Response("Not found",{status:404});
}});
console.log(`Chile Transparente: http://localhost:${server.port}`);
