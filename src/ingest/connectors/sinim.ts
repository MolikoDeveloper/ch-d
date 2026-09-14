import { db, finishRun, startRun } from "../../db";
import { normalizeGeoName, resolveGeoArea } from "../../geo";
import { fetchAndSnapshot } from "../raw";
import { isParseableFormat, parseResource } from "../parsers/tabular";

const FICHA_URL="https://datos.sinim.gov.cl/ficha_comunal.php";
const SKIP_KEYS=/^(?:__|año|ano|year|fecha|codigo|código|cod|comuna|municipio|region|región|provincia|nombre|id)/i;

function numeric(v:unknown){if(v==null)return null;const s=String(v).trim().replace(/\s/g,"").replace(/\.(?=\d{3}(?:\D|$))/g,"").replace(",",".").replace(/%$/,"");if(!s||/^(?:n\/?a|s\/?d|sin dato|no aplica|no recepcionado|-+)$/i.test(s))return null;const n=Number(s);return Number.isFinite(n)?n:null}
function yearFrom(...values:unknown[]){for(const v of values){const m=String(v??"").match(/\b(19|20)\d{2}\b/);if(m)return Number(m[0])}return null}
function field(row:Record<string,unknown>,re:RegExp){for(const[k,v]of Object.entries(row))if(re.test(normalizeGeoName(k)))return v;return null}
function metricId(resourceId:string,column:string){const h=new Bun.CryptoHasher("sha256");h.update(`${resourceId}:${column}`);return`sinim:${h.digest("hex").slice(0,20)}`}

function seedCommunes(html:string){
  const matches=[...html.matchAll(/>([^<>]{2,90}?)\s*-\s*(\d{5})</g)];
  const unique=new Map<string,string>();
  for(const m of matches){const name=m[1].replace(/&[a-z]+;/gi," ").replace(/\s+/g," ").trim();if(name&&!/seleccione/i.test(name))unique.set(m[2],name)}
  const ins=db.prepare(`INSERT INTO geo_areas(geo_type,code,name,parent_id,source_id,external_id) VALUES('commune',?,?,?,'sinim',?) ON CONFLICT(source_id,external_id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id`);
  const alias=db.prepare(`INSERT OR REPLACE INTO geo_aliases(alias,normalized_alias,geo_area_id) VALUES(?,?,?)`);
  let written=0;
  for(const[code,name]of unique){const parent=resolveGeoArea(code.slice(0,2),null);ins.run(code,name,parent,`COM-${code}`);const g=db.query(`SELECT id FROM geo_areas WHERE source_id='sinim' AND external_id=?`).get(`COM-${code}`)as{id:number};for(const a of[name,code])alias.run(a,normalizeGeoName(a),g.id);written++}
  return written;
}

export async function syncSinim(){
  const run=startRun("sinim");let seen=0,written=0,failed=0;
  try{
    console.log("[sinim] Descargando catálogo comunal oficial...");
    const ficha=await fetchAndSnapshot("sinim",run,FICHA_URL);
    const communes=seedCommunes(ficha.text);
    console.log(`[sinim] ${communes} comunas registradas/resueltas`);

    const resources=db.query(`SELECT sr.id,sr.external_id,sr.name,sr.format,sr.url,sci.external_id dataset_id,sci.title dataset_title,sci.publisher FROM source_resources sr JOIN source_catalog_items sci ON sci.id=sr.catalog_item_id WHERE sci.source_id='datos-gob' AND lower(COALESCE(sci.publisher,'')) LIKE '%desarrollo regional%' ORDER BY sci.title,sr.id`).all() as any[];
    const candidates=resources.filter(r=>isParseableFormat(r.format,r.url)&&/(municip|comuna|salud|educa|gasto|parque|plaza|predio|infraestructura|presupuesto)/i.test(`${r.dataset_title} ${r.name??''}`)).slice(0,Number(process.env.SINIM_RESOURCE_LIMIT??20));
    console.log(`[sinim] ${candidates.length} recursos municipales SUBDERE encontrados en Datos.gob`);

    for(let i=0;i<candidates.length;i++){
      const r=candidates[i];console.log(`[sinim] ${i+1}/${candidates.length} ${r.dataset_title}`);
      try{
        const snap=await fetchAndSnapshot("sinim",run,r.url);
        const rows=parseResource(r.format,snap.bytes,snap.text);seen+=rows.length;
        const datasetYear=yearFrom(r.dataset_title,r.name);
        const metricStmt=db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json) VALUES('sinim',?,?,?,?,?,?,?,'commune',?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,metadata_json=excluded.metadata_json`);
        const obsStmt=db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json) VALUES('sinim',?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(source_id,external_id,metric) DO UPDATE SET value_number=excluded.value_number,value_text=excluded.value_text,geo_area_id=excluded.geo_area_id,raw_snapshot_id=excluded.raw_snapshot_id`);
        let resourceWritten=0;
        db.transaction(()=>{
          for(const row of rows){
            const code=field(row,/(codigo territorial|cod comuna|codigo comuna|cut comuna|codigo municipio)/i);const name=field(row,/(^comuna$|municipio|nombre comuna)/i);const geo=resolveGeoArea(code?String(code):null,name?String(name):null);if(!geo)continue;
            const year=yearFrom(field(row,/(^ano$|^año$|year|periodo)/i),datasetYear)??datasetYear;const observed=year?`${year}-12-31`:null;
            for(const[col,val]of Object.entries(row)){if(SKIP_KEYS.test(normalizeGeoName(col)))continue;const n=numeric(val);if(n==null)continue;const metric=metricId(r.external_id,col);metricStmt.run(metric,col,r.dataset_title,"municipal",r.dataset_title,null,"annual",JSON.stringify({datasetId:r.dataset_id,resourceId:r.external_id,column:col,via:"datos.gob.cl",publisher:r.publisher}));const ext=`${r.external_id}:${metric}:${geo}:${observed??'na'}`;obsStmt.run(ext,observed,metric,n,null,null,geo,"commune",String(code??name??geo),snap.snapshotId);written++;resourceWritten++}
          }
        })();
        console.log(`[sinim] ${i+1}/${candidates.length} ✓ filas=${rows.length} observaciones=${resourceWritten}`);
      }catch(e){failed++;console.error(`[sinim] ${i+1}/${candidates.length} ! ${String(e)}`)}
      db.prepare(`UPDATE ingest_runs SET records_seen=?,records_written=?,message=? WHERE id=?`).run(seen,written,`${i+1}/${candidates.length} recursos; failed=${failed}`,run);
    }
    finishRun(run,"success",`comunas=${communes}; recursos=${candidates.length}; failed=${failed}`,seen,written);return{communes,resources:candidates.length,seen,written,failed};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
