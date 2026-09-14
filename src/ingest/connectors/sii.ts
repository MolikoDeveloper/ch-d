import { unzipSync } from "fflate";
import { db, finishRun, startRun, updateRunProgress } from "../../db";
import { resolveGeoArea } from "../../geo";
import { fetchAndSnapshot } from "../raw";
import { parseCsv } from "../parsers/tabular";

type Row=Record<string,unknown>;
const URL="https://www.sii.cl/sobre_el_sii/empresas/EMPRESAS.zip";

function norm(v:unknown){return String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim()}
function clean(v:unknown){return String(v??"").replace(/\s+/g," ").trim()}
function numeric(v:unknown){if(typeof v==="number")return Number.isFinite(v)?v:null;const raw=clean(v);if(!raw||raw==="*"||/^s\/?i$/i.test(raw))return null;let s=raw.replace(/\s/g,"");if(/^[-+]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s))s=s.replace(/\./g,"").replace(",",".");else if(/^[-+]?\d+(?:,\d+)?$/.test(s))s=s.replace(",",".");const n=Number(s);return Number.isFinite(n)?n:null}
function code(v:unknown){const s=clean(v).replace(/\.0+$/,"").replace(/\D/g,"");return s.length>=4&&s.length<=5?s.padStart(5,"0"):""}
function field(row:Row,test:(k:string)=>boolean){for(const[k,v]of Object.entries(row))if(test(norm(k)))return v;return null}
function year(row:Row){const v=field(row,k=>/ano comercial|ano tributario|^ano$/.test(k));const n=Number(clean(v).replace(/\D/g,""));return n>=2000&&n<=2100?n:null}
function commune(row:Row){const c=field(row,k=>(k.includes("codigo")||k.includes("cod ")||k.startsWith("cod"))&&k.includes("comuna"));const n=field(row,k=>k==="comuna"||k.endsWith(" comuna"));const cc=code(c),name=clean(n);return{code:cc,name,geoId:cc?resolveGeoArea(cc,null):name?resolveGeoArea(`Comuna de ${name}`,null):null}}
function isDimension(h:string){const n=norm(h);return /ano comercial|ano tributario|^ano$|region|provincia|comuna|codigo|rubro|subrubro|actividad|tramo|genero/.test(n)}
function unit(header:string){const n=norm(header);if(n.includes("uf"))return"UF";if(n.includes("renta")||n.includes("remuner"))return n.includes("uf")?"UF":"CLP";if(n.includes("numero")||n.includes("cantidad")||n.includes("trabajador")||n.includes("empresa"))return"N°";return null}
function metricId(header:string){const h=new Bun.CryptoHasher("sha256");h.update(norm(header));return`sii:${h.digest("hex").slice(0,24)}`}
function decode(bytes:Uint8Array){const utf=new TextDecoder("utf-8").decode(bytes);const bad=(utf.match(/�/g)??[]).length;if(bad<3)return utf;return new TextDecoder("windows-1252").decode(bytes)}
function fileScore(name:string){const n=norm(name);let s=n.includes("comuna")?10:0;if(/rubro|subrubro|actividad|tramo|genero|provincia|region/.test(n))s-=8;if(/empresa/.test(n))s+=2;return s}

export async function syncSii(){
  const run=startRun("sii");let seen=0,written=0,failed=0;
  try{
    console.log("[sii] Descargando estadísticas abiertas de empresas...");
    const snap=await fetchAndSnapshot("sii",run,URL),files=unzipSync(snap.bytes);
    const candidates=Object.entries(files).filter(([name])=>/\.(?:txt|csv|tsv)$/i.test(name)&&norm(name).includes("comuna")).sort((a,b)=>fileScore(b[0])-fileScore(a[0]));
    if(!candidates.length)throw new Error("ZIP SII sin archivos por comuna reconocibles");
    const best=fileScore(candidates[0][0]);const selected=candidates.filter(([name])=>fileScore(name)===best);
    console.log(`[sii] ${Object.keys(files).length} archivos en ZIP · procesando ${selected.length}: ${selected.map(x=>x[0]).join(", ")}`);
    const metric=db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json) VALUES('sii',?,?,?,?,?,?,?,'commune',?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,unit=excluded.unit,metadata_json=excluded.metadata_json`);
    const obs=db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json) VALUES('sii',?,?,?,?,NULL,?,?,?,?,?,?) ON CONFLICT(source_id,external_id,metric) DO UPDATE SET value_number=excluded.value_number,unit=excluded.unit,geo_area_id=excluded.geo_area_id,raw_snapshot_id=excluded.raw_snapshot_id,payload_json=excluded.payload_json`);
    for(let fi=0;fi<selected.length;fi++){
      const[name,data]=selected[fi];try{
        const rows=parseCsv(decode(data));let local=0;console.log(`[sii] ${fi+1}/${selected.length} ${name} · filas=${rows.length}`);
        db.transaction(()=>{
          for(const row of rows){seen++;const y=year(row),geo=commune(row);if(!y||!geo.geoId)continue;
            for(const[header,raw]of Object.entries(row)){if(isDimension(header))continue;const value=numeric(raw);if(value==null)continue;const id=metricId(header),u=unit(header);
              metric.run(id,clean(header),"Estadísticas de Empresas del Servicio de Impuestos Internos. Los valores suprimidos por reserva tributaria no se imputan.","economia","Empresas por comuna",u,"annual",JSON.stringify({sourceFile:name,mapEligible:true,privacySuppression:"* = dato no publicable por reserva tributaria"}));
              obs.run(`${geo.code||geo.name}:${id}:${y}`,String(y),id,value,u,geo.geoId,"commune",geo.code||geo.name,snap.snapshotId,JSON.stringify({sourceFile:name,year:y}));written++;local++;
            }
          }
        })();
        console.log(`[sii] ✓ ${name} · observaciones=${local}`);
      }catch(e){failed++;console.error(`[sii] ! ${name}: ${String(e)}`)}updateRunProgress(run,seen,written,`${fi+1}/${selected.length} archivos; failed=${failed}`)
    }
    finishRun(run,written?"success":"failed",`files=${selected.length}; failed=${failed}`,seen,written);if(!written)throw new Error("SII no produjo observaciones comunales");return{files:selected.length,seen,written,failed};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
