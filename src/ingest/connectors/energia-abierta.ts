import { db, finishRun, startRun } from "../../db";
import { resolveGeoArea } from "../../geo";
import { fetchAndSnapshot } from "../raw";
import { isParseableFormat, parseResource } from "../parsers/tabular";

type ResourceRow={
  id:number; external_id:string; name:string|null; format:string|null; url:string;
  dataset_id:string; dataset_title:string; updated_at:string|null;
};

type Row=Record<string,unknown>;

const TARGETS=["Generación Bruta","Generación Distribuida","Capacidad Instalada","Factor de Emisión"];
const DATE_KEYS=["fecha","date","periodo","período","mes","año","ano","year"];
const REGION_KEYS=["region","región","nombre_region","nombre región","nom_region"];
const SUBJECT_KEYS=["central","instalacion","instalación","planta","comuna","empresa","sistema","tecnologia","tecnología"];

function norm(v:string){return v.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")}
function pick(row:Row,keys:string[]){for(const [k,v] of Object.entries(row)){if(keys.includes(k.toLowerCase())) return v}return null}
function numberValue(v:unknown){
  if(typeof v==="number") return Number.isFinite(v)?v:null;
  if(typeof v!=="string") return null;
  const s=v.trim().replace(/\s/g,""); if(!s||!/[0-9]/.test(s)) return null;
  let n:number;
  if(/^[-+]?\d{1,3}(\.\d{3})*,\d+$/.test(s)) n=Number(s.replace(/\./g,"").replace(",","."));
  else if(/^[-+]?\d+,\d+$/.test(s)) n=Number(s.replace(",","."));
  else n=Number(s.replace(/,/g,""));
  return Number.isFinite(n)?n:null;
}
function dateValue(v:unknown,fallback:string|null){
  if(v==null||v==="") return fallback;
  const s=String(v).trim();
  if(/^\d{4}$/.test(s)) return `${s}-01-01`;
  if(/^\d{4}-\d{1,2}$/.test(s)){const [y,m]=s.split("-");return `${y}-${m.padStart(2,"0")}-01`}
  const d=new Date(s); return Number.isNaN(d.getTime())?fallback:d.toISOString().slice(0,10);
}
function hashRow(v:unknown){const h=new Bun.CryptoHasher("sha256");h.update(JSON.stringify(v));return h.digest("hex").slice(0,24)}

function resources(){
  const placeholders=TARGETS.map(()=>"?").join(",");
  return db.query(`SELECT r.id,r.external_id,r.name,r.format,r.url,c.external_id dataset_id,c.title dataset_title,c.updated_at
    FROM source_resources r JOIN source_catalog_items c ON c.id=r.catalog_item_id
    WHERE c.source_id='datos-gob' AND c.publisher LIKE '%Comisión Nacional de Energía%'
      AND c.title IN (${placeholders})
    ORDER BY c.title,r.id`).all(...TARGETS) as ResourceRow[];
}

export async function syncEnergiaAbierta(){
  const run=startRun("energia-abierta"); let seen=0,written=0,metrics=0,failed=0;
  try{
    const rs=resources();
    if(!rs.length) throw new Error("No hay datasets CNE catalogados. Ejecuta primero bun run sync:datos");
    console.log(`[energia] ${rs.length} recursos oficiales CNE encontrados`);
    const metricStmt=db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json)
      VALUES('energia-abierta',?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,metadata_json=excluded.metadata_json`);
    const obsStmt=db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json)
      VALUES('energia-abierta',?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,external_id,metric) DO UPDATE SET observed_at=excluded.observed_at,value_number=excluded.value_number,geo_area_id=excluded.geo_area_id,raw_snapshot_id=excluded.raw_snapshot_id,payload_json=excluded.payload_json`);
    for(let i=0;i<rs.length;i++){
      const r=rs[i];
      try{
        if(!isParseableFormat(r.format??"",r.url)){console.log(`[energia] ${i+1}/${rs.length} omitido ${r.dataset_title}: formato ${r.format??"?"}`);continue}
        console.log(`[energia] ${i+1}/${rs.length} descargando ${r.dataset_title} · ${r.name??r.format??"recurso"}`);
        const snap=await fetchAndSnapshot("energia-abierta",run,r.url);
        const parsed=parseResource(r.format??"CSV",snap.bytes,snap.text);
        const fallback=r.updated_at?.slice(0,10)??null;
        const knownMetrics=new Set<string>();
        db.transaction(()=>{
          for(const row of parsed){
            seen++;
            const date=dateValue(pick(row,DATE_KEYS),fallback);
            const region=pick(row,REGION_KEYS); const geo=region?resolveGeoArea(null,String(region)):null;
            const subject=pick(row,SUBJECT_KEYS); const rowHash=hashRow(row);
            for(const [column,raw] of Object.entries(row)){
              if(column.startsWith("__")) continue;
              const value=numberValue(raw); if(value===null) continue;
              if(DATE_KEYS.includes(column.toLowerCase())||REGION_KEYS.includes(column.toLowerCase())) continue;
              const metric=`${r.dataset_id}:${norm(column)}`;
              if(!knownMetrics.has(metric)){
                metricStmt.run(metric,`${r.dataset_title} — ${column}`,`Columna ${column} del dataset oficial ${r.dataset_title}.`,"energia",norm(r.dataset_title),null,null,geo?"region":"country",JSON.stringify({datasetId:r.dataset_id,datasetTitle:r.dataset_title,resourceId:r.external_id,column}));
                knownMetrics.add(metric); metrics++;
              }
              obsStmt.run(`${r.external_id}:${rowHash}:${norm(column)}`,date,metric,value,null,null,geo,"energy_record",subject?String(subject):null,snap.snapshotId,JSON.stringify({dataset:r.dataset_title,row}));
              written++;
            }
          }
        })();
        db.prepare(`UPDATE ingest_runs SET records_seen=?,records_written=?,message=? WHERE id=?`).run(seen,written,`${i+1}/${rs.length} recursos; failed=${failed}`,run);
        console.log(`[energia] ${i+1}/${rs.length} ✓ ${r.dataset_title} · filas=${parsed.length} obs=${written}`);
      }catch(e){failed++;console.error(`[energia] ${r.dataset_title}: ${String(e)}`)}
    }
    finishRun(run,"success",`resources=${rs.length}; metrics=${metrics}; failed=${failed}`,seen,written);
    return {resources:rs.length,seen,written,metrics,failed};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
