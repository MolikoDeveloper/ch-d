import { db, finishRun, startRun, updateRunProgress } from "../../db";
import { resolveGeoArea } from "../../geo";
import { fetchAndSnapshot } from "../raw";
import { parseCsv } from "../parsers/tabular";

type EntityKind="persons"|"households";
type Scope="commune"|"unit_vecinal";
type Row=Record<string,unknown>;

type PackageResource={id?:string;name?:string;format?:string;url?:string;last_modified?:string;created?:string};
type PackageResult={name?:string;title?:string;resources?:PackageResource[]};

const CKAN="https://bid-ckan.ministeriodesarrollosocial.gob.cl/api/3/action";
const SUBCATEGORY="Calificación Socioeconómica (RSH)";
const TRANCHES=[
  {id:"0-40",tokens:["0","40"]},
  {id:"41-50",tokens:["41","50"]},
  {id:"51-60",tokens:["51","60"]},
  {id:"61-70",tokens:["61","70"]},
  {id:"71-80",tokens:["71","80"]},
  {id:"81-90",tokens:["81","90"]},
  {id:"91-100",tokens:["91","100"]},
] as const;

const DATASETS:Array<{kind:EntityKind;slug:string;label:string}>=[
  {kind:"persons",slug:"personas-en-rsh-segun-cse",label:"Personas en RSH según CSE"},
  {kind:"households",slug:"hogares-en-rsh-segun-cse",label:"Hogares en RSH según CSE"},
];

const metricCache=new Set<string>();
const unitGeoCache=new Map<string,number>();

function ensureSource(){
  db.prepare(`INSERT INTO sources(id,name,institution,domain,base_url,auth_kind,automatic,metadata_json)
    VALUES('rsh','Registro Social de Hogares','Ministerio de Desarrollo Social y Familia','social','https://bidat.gob.cl','none',1,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,institution=excluded.institution,domain=excluded.domain,base_url=excluded.base_url,automatic=excluded.automatic,metadata_json=excluded.metadata_json`)
    .run(JSON.stringify({description:"Distribución territorial de personas y hogares según Calificación Socioeconómica del Registro Social de Hogares.",territorialLevels:["region","comuna","unidad-vecinal"],license:"CC BY"}));
}

function norm(v:string){return v.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim()}
function normalizeCode(v:unknown,size:number){const s=String(v??"").trim().replace(/\.0+$/,"").replace(/\D/g,"");return s?s.padStart(size,"0"):""}
function uvCode(v:unknown){const raw=String(v??"").trim().replace(/\.0+$/,"");if(!raw||/^s\/?n$/i.test(raw))return null;const s=raw.replace(/\D/g,"");return s||null}
function numeric(v:unknown){if(typeof v==="number")return Number.isFinite(v)?v:null;const s=String(v??"").trim().replace(/\.(?=\d{3}(?:\D|$))/g,"").replace(",",".");if(!s)return null;const n=Number(s);return Number.isFinite(n)?n:null}
function periodDate(v:unknown,fallback:string){const s=String(v??"").replace(/\D/g,"");if(/^\d{8}$/.test(s))return`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;if(/^\d{6}$/.test(s))return`${s.slice(0,4)}-${s.slice(4,6)}-01`;return fallback}
function normalizedEntries(row:Row){return Object.entries(row).map(([k,v])=>[norm(k),v] as const)}
function field(row:Row,name:string){const n=norm(name);for(const[k,v]of normalizedEntries(row))if(k===n)return v;return null}
function valueBy(row:Row,tokens:string[]){for(const[k,v]of normalizedEntries(row)){if(tokens.every(t=>k.includes(norm(t))))return v}return null}
function entityWord(kind:EntityKind){return kind==="persons"?"personas":"hogares"}
function scopeWord(scope:Scope){return scope==="commune"?"comuna":"uv"}
function metricId(kind:EntityKind,scope:Scope,key:string,measure:"count"|"pct"){return`rsh:${kind}:${scope}:${key}:${measure}`}
function metricTitle(kind:EntityKind,key:string,measure:"count"|"pct"){
  const entity=kind==="persons"?"Personas":"Hogares";
  if(key==="0-70")return`${entity} RSH en tramos 0–70 (menores ingresos / mayor vulnerabilidad)${measure==="pct"?" — porcentaje":""}`;
  if(key==="71-100")return`${entity} RSH en tramos 71–100 (mayores ingresos / menor vulnerabilidad)${measure==="pct"?" — porcentaje":""}`;
  if(key==="total")return`${entity} presentes en el RSH`;
  return`${entity} RSH en tramo ${key}${measure==="pct"?" — porcentaje":""}`;
}
function fallbackPeriod(resource:PackageResource){const m=String(resource.name??"").match(/(\d{2})\/(\d{4})/);return m?`${m[2]}-${m[1]}-01`:new Date().toISOString().slice(0,7)+"-01"}
function resourceRank(r:PackageResource){const m=String(r.name??"").match(/(\d{2})\/(\d{4})/);if(m)return Number(`${m[2]}${m[1]}`);const d=Date.parse(String(r.last_modified??r.created??""));return Number.isFinite(d)?Math.floor(d/86400000):0}

async function packageFor(run:number,base:string){
  const year=new Date().getFullYear();
  let last:unknown=null;
  for(const y of[year,year-1]){
    const slug=`${base}-${y}`,url=`${CKAN}/package_show?id=${encodeURIComponent(slug)}`;
    try{
      const snap=await fetchAndSnapshot("rsh",run,url);
      const json=JSON.parse(snap.text) as {success?:boolean;result?:PackageResult};
      if(json.success&&json.result)return json.result;
      last=new Error(`CKAN package_show sin resultado: ${slug}`);
    }catch(e){last=e}
  }
  throw last??new Error(`No se encontró dataset ${base}`);
}

function latestCsv(pkg:PackageResult){
  const rs=(pkg.resources??[]).filter(r=>String(r.format??"").toUpperCase().includes("CSV")&&r.url);
  if(!rs.length)throw new Error(`Dataset ${pkg.title??pkg.name??"RSH"} sin recursos CSV`);
  return rs.sort((a,b)=>resourceRank(b)-resourceRank(a))[0];
}

function upsertMetric(kind:EntityKind,scope:Scope,key:string,measure:"count"|"pct",metadata:Record<string,unknown>){
  const id=metricId(kind,scope,key,measure);if(metricCache.has(id))return id;
  const unit=measure==="pct"?"%":kind==="persons"?"personas":"hogares";
  db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json)
    VALUES('rsh',?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,description=excluded.description,unit=excluded.unit,frequency=excluded.frequency,geo_scope=excluded.geo_scope,metadata_json=excluded.metadata_json`)
    .run(id,metricTitle(kind,key,measure),"Distribución oficial del Registro Social de Hogares según Calificación Socioeconómica.","social",SUBCATEGORY,unit,"monthly",scope==="commune"?"commune":"unit_vecinal",JSON.stringify(metadata));
  metricCache.add(id);return id;
}

function ensureUnitVecinal(code:string,parentId:number){
  const cacheKey=`${parentId}:${code}`,cached=unitGeoCache.get(cacheKey);if(cached)return cached;
  const ext=`UV-${code}`;
  db.prepare(`INSERT INTO geo_areas(geo_type,code,name,parent_id,source_id,external_id)
    VALUES('unit_vecinal',?,?,?,'rsh',?)
    ON CONFLICT(source_id,external_id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name`).run(code,`Unidad vecinal ${code}`,parentId,ext);
  const id=Number((db.query(`SELECT id FROM geo_areas WHERE source_id='rsh' AND external_id=?`).get(ext)as any).id);unitGeoCache.set(cacheKey,id);return id;
}

const observationStmt=()=>db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json)
  VALUES('rsh',?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(source_id,external_id,metric) DO UPDATE SET observed_at=excluded.observed_at,value_number=excluded.value_number,unit=excluded.unit,geo_area_id=excluded.geo_area_id,subject_type=excluded.subject_type,subject_id=excluded.subject_id,raw_snapshot_id=excluded.raw_snapshot_id,payload_json=excluded.payload_json`);

function writeObservation(args:{kind:EntityKind;scope:Scope;geoId:number;subjectId:string;period:string;key:string;count:number;total:number;snapshotId:number;resource:PackageResource;derived?:boolean}){
  const {kind,scope,geoId,subjectId,period,key,count,total,snapshotId,resource,derived=false}=args;
  const common={dataset:kind,scope,key,resourceId:resource.id??null,resourceName:resource.name??null,derived};
  const countMetric=upsertMetric(kind,scope,key,"count",common),pctMetric=upsertMetric(kind,scope,key,"pct",common),stmt=observationStmt();
  stmt.run(`${kind}:${scope}:${subjectId}:${period}:${key}:count`,period,countMetric,count,null,kind==="persons"?"personas":"hogares",geoId,`rsh_${scope}`,subjectId,snapshotId,JSON.stringify(common));
  const pct=total>0?count/total*100:null;
  if(pct!=null)stmt.run(`${kind}:${scope}:${subjectId}:${period}:${key}:pct`,period,pctMetric,pct,null,"%",geoId,`rsh_${scope}`,subjectId,snapshotId,JSON.stringify(common));
  return pct==null?1:2;
}

function processScope(kind:EntityKind,scope:Scope,row:Row,geoId:number,subjectId:string,period:string,snapshotId:number,resource:PackageResource){
  const ew=entityWord(kind),sw=scopeWord(scope),total=numeric(valueBy(row,["total",sw]));if(total==null||total<=0)return 0;
  let written=0;const counts=new Map<string,number>();
  for(const t of TRANCHES){const v=numeric(valueBy(row,[`numero de ${ew}`,"tramo",...t.tokens,sw]));if(v!=null)counts.set(t.id,v)}
  for(const [key,count]of counts)written+=writeObservation({kind,scope,geoId,subjectId,period,key,count,total,snapshotId,resource});
  const lower=["0-40","41-50","51-60","61-70"].reduce((a,k)=>a+(counts.get(k)??0),0),upper=["71-80","81-90","91-100"].reduce((a,k)=>a+(counts.get(k)??0),0);
  written+=writeObservation({kind,scope,geoId,subjectId,period,key:"0-70",count:lower,total,snapshotId,resource,derived:true});
  written+=writeObservation({kind,scope,geoId,subjectId,period,key:"71-100",count:upper,total,snapshotId,resource,derived:true});
  const totalMetric=upsertMetric(kind,scope,"total","count",{dataset:kind,scope,resourceId:resource.id??null}),stmt=observationStmt();
  stmt.run(`${kind}:${scope}:${subjectId}:${period}:total`,period,totalMetric,total,null,kind==="persons"?"personas":"hogares",geoId,`rsh_${scope}`,subjectId,snapshotId,JSON.stringify({dataset:kind,scope,resourceId:resource.id??null}));
  return written+1;
}

export async function syncRsh(){
  ensureSource();metricCache.clear();unitGeoCache.clear();
  const run=startRun("rsh");let seen=0,written=0,failed=0,units=0,communes=0;
  try{
    console.log("[rsh] Sincronizando Calificación Socioeconómica territorial...");
    for(let d=0;d<DATASETS.length;d++){
      const dataset=DATASETS[d];
      try{
        const pkg=await packageFor(run,dataset.slug),resource=latestCsv(pkg);
        console.log(`[rsh] ${dataset.label}: ${resource.name??"CSV más reciente"}`);
        const snap=await fetchAndSnapshot("rsh",run,String(resource.url)),parsed=parseCsv(snap.text),fallback=fallbackPeriod(resource),seenCommunes=new Set<string>();
        db.transaction(()=>{
          for(const row of parsed){
            seen++;
            const communeCode=normalizeCode(field(row,"comuna"),5);if(!communeCode)continue;
            const communeGeo=resolveGeoArea(communeCode,null);if(!communeGeo)continue;
            const period=periodDate(field(row,"periodo"),fallback);
            if(!seenCommunes.has(communeCode)){written+=processScope(dataset.kind,"commune",row,communeGeo,communeCode,period,snap.snapshotId,resource);seenCommunes.add(communeCode);communes++}
            const uv=uvCode(field(row,"unidad vecinal"));if(!uv)continue;
            const uvGeo=ensureUnitVecinal(uv,communeGeo);written+=processScope(dataset.kind,"unit_vecinal",row,uvGeo,uv,period,snap.snapshotId,resource);units++;
          }
        })();
        console.log(`[rsh] ✓ ${dataset.label} · filas=${parsed.length} comunas=${seenCommunes.size}`);
      }catch(e){failed++;console.error(`[rsh] ${dataset.label}: ${String(e)}`)}
      updateRunProgress(run,seen,written,`${d+1}/${DATASETS.length} datasets; comunas=${communes}; unidades_vecinales=${units}; failed=${failed}`);
    }
    finishRun(run,failed===DATASETS.length?"failed":"success",`datasets=${DATASETS.length}; comunas=${communes}; unidades_vecinales=${units}; failed=${failed}`,seen,written);
    if(failed===DATASETS.length)throw new Error("No fue posible sincronizar datasets RSH");
    return{datasets:DATASETS.length,seen,written,communes,units,failed};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
