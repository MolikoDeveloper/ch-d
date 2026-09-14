import * as XLSX from "xlsx";
import { db, finishRun, startRun, updateRunProgress } from "../../db";
import { resolveGeoArea } from "../../geo";
import { fetchAndSnapshot } from "../raw";

type Resource={id?:string;name?:string;format?:string;url?:string};
type Package={name?:string;title?:string;resources?:Resource[];metadata_modified?:string};
type Row=unknown[];
type Numeric={value:number;pct:boolean};

const CKAN="https://bid-ckan.ministeriodesarrollosocial.gob.cl/api/3/action";

function norm(v:unknown){return String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9%]+/g," ").replace(/\s+/g," ").trim()}
function clean(v:unknown){return String(v??"").replace(/\s+/g," ").trim()}
function numeric(v:unknown):Numeric|null{if(typeof v==="number")return Number.isFinite(v)?{value:v,pct:false}:null;let s=clean(v);if(!s||/^[-*]+$/.test(s)||/^(?:n\/?a|s\/?i|sin dato)$/i.test(s))return null;const pct=s.includes("%");s=s.replace(/%/g,"").replace(/\.(?=\d{3}(?:\D|$))/g,"").replace(",",".");const n=Number(s);return Number.isFinite(n)?{value:n,pct}:null}
function code(v:unknown){const s=clean(v).replace(/\.0+$/,"").replace(/\D/g,"");return s.length>=4&&s.length<=5?s.padStart(5,"0"):""}
function yearOf(pkg:Package){const m=`${pkg.title??""} ${pkg.name??""}`.match(/\b(20\d{2}|201\d)\b/);return m?Number(m[1]):null}
function theme(resource:Resource){const n=norm(resource.name);if(n.includes("multidimensional"))return{key:"pobreza-multidimensional",label:"Pobreza multidimensional"};if(n.includes("inseguridad alimentaria"))return{key:"inseguridad-alimentaria",label:"Inseguridad alimentaria"};return{key:"pobreza-ingresos",label:"Pobreza por ingresos"}}
function role(header:string){const n=norm(header);if(/estimacion|tasa|incidencia|porcentaje|indice/.test(n)&&!/error|inferior|superior|coeficiente/.test(n))return"estimate";if(/error estandar/.test(n))return"standard_error";if(/inferior/.test(n))return"ci_lower";if(/superior/.test(n))return"ci_upper";if(/coeficiente.*variacion|cv\b/.test(n))return"cv";return"other"}
function isGeoHeader(h:string){const n=norm(h);return /(^| )(region|provincia|comuna|codigo comuna|cod comuna|cut comuna|codigo region|codigo provincia)( |$)/.test(n)}
function headerScore(row:Row){let score=0;for(const c of row){const n=norm(c);if(n.includes("comuna"))score+=5;if(n.includes("codigo")||n.includes("cut"))score+=2;if(/estimacion|tasa|indice|error estandar|intervalo/.test(n))score+=3}return score}
function headers(row:Row){const seen=new Map<string,number>();return row.map((v,i)=>{let h=clean(v)||`col_${i+1}`;const base=h,n=(seen.get(base)??0)+1;seen.set(base,n);if(n>1)h=`${h} ${n}`;return h})}
function findHeader(matrix:Row[]){let best={at:-1,score:0};for(let i=0;i<Math.min(30,matrix.length);i++){const s=headerScore(matrix[i]??[]);if(s>best.score)best={at:i,score:s}}return best.score>=5?best.at:-1}
function metricTitle(resource:Resource,header:string){const r=theme(resource),n=norm(header);if(/^(estimacion|tasa|porcentaje|incidencia|indice|valor)$/.test(n))return r.label;return`${r.label} — ${clean(header)}`}
function metricId(resource:Resource,header:string){const t=theme(resource),r=role(header),h=new Bun.CryptoHasher("sha256");h.update(`${t.key}:${r}:${norm(header).replace(/\b20\d{2}\b/g,"")}`);return`casen:${h.digest("hex").slice(0,24)}`}
async function packageSearch(run:number,q:string){const url=`${CKAN}/package_search?q=${encodeURIComponent(q)}&rows=100`,snap=await fetchAndSnapshot("casen",run,url),json=JSON.parse(snap.text)as any;if(!json?.success)throw new Error(`CKAN package_search falló: ${q}`);return(json.result?.results??[])as Package[]}
function resolveCommune(row:Record<string,unknown>){let communeCode="",communeName="";for(const[k,v]of Object.entries(row)){const n=norm(k);if((n.includes("codigo")||n.includes("cut"))&&n.includes("comuna"))communeCode=code(v)||communeCode;else if(n==="comuna"||n.endsWith(" comuna"))communeName=clean(v)||communeName}return{communeCode,communeName,geoId:communeCode?resolveGeoArea(communeCode,null):communeName?resolveGeoArea(`Comuna de ${communeName}`,null):null}}

export async function syncCasen(){
  const run=startRun("casen");let seen=0,written=0,failed=0,resourcesDone=0;
  try{
    console.log("[casen] Buscando estimaciones comunales oficiales en BIDAT/CKAN...");
    const found=[...(await packageSearch(run,"base de datos indicadores comunales")),...(await packageSearch(run,"base de datos pobreza comunal"))];
    const packages=[...new Map(found.filter(p=>yearOf(p)).map((p,i)=>[p.name??p.title??String(i),p])).values()].sort((a,b)=>(yearOf(a)??0)-(yearOf(b)??0));
    const requested=(process.env.CASEN_YEARS??"").split(",").map(x=>Number(x.trim())).filter(Number.isFinite),selected=requested.length?packages.filter(p=>requested.includes(yearOf(p)!)):packages;
    const resources=selected.flatMap(pkg=>(pkg.resources??[]).filter(r=>r.url&&String(r.format??"").toUpperCase().includes("XLSX")).map(resource=>({pkg,resource}))).slice(0,Number(process.env.CASEN_RESOURCE_LIMIT??9999));
    console.log(`[casen] ${selected.length} datasets · ${resources.length} recursos XLSX`);
    const metric=db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json) VALUES('casen',?,?,?,?,?,?,?,'commune',?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,description=excluded.description,subcategory=excluded.subcategory,unit=excluded.unit,metadata_json=excluded.metadata_json`);
    const obs=db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json) VALUES('casen',?,?,?,?,NULL,?,?,?,?,?,?) ON CONFLICT(source_id,external_id,metric) DO UPDATE SET observed_at=excluded.observed_at,value_number=excluded.value_number,unit=excluded.unit,geo_area_id=excluded.geo_area_id,raw_snapshot_id=excluded.raw_snapshot_id,payload_json=excluded.payload_json`);
    for(let ri=0;ri<resources.length;ri++){
      const{pkg,resource}=resources[ri],year=yearOf(pkg)!;
      try{
        console.log(`[casen] ${ri+1}/${resources.length} ${year} · ${resource.name}`);const snap=await fetchAndSnapshot("casen",run,String(resource.url)),wb=XLSX.read(snap.bytes,{type:"array",cellDates:false,raw:false});let local=0;
        db.transaction(()=>{for(const sheetName of wb.SheetNames){const matrix=XLSX.utils.sheet_to_json<Row>(wb.Sheets[sheetName],{header:1,defval:null,raw:false})as Row[],hi=findHeader(matrix);if(hi<0)continue;const hs=headers(matrix[hi]);for(const arr of matrix.slice(hi+1)){if(!arr?.some(v=>clean(v)))continue;const row=Object.fromEntries(hs.map((h,i)=>[h,arr[i]??null]))as Record<string,unknown>;seen++;const geo=resolveCommune(row);if(!geo.geoId)continue;for(const[header,raw]of Object.entries(row)){if(isGeoHeader(header))continue;const parsed=numeric(raw);if(!parsed)continue;const id=metricId(resource,header),r=role(header),t=theme(resource),unit=parsed.pct||r!=="other"?"%":null;metric.run(id,metricTitle(resource,header),`${clean(resource.name)}. Estimación comunal oficial publicada por MDSF/BIDAT.`,"social",t.label,unit,"annual",JSON.stringify({dataset:pkg.name,title:pkg.title,resourceId:resource.id,resourceName:resource.name,year,role:r,mapEligible:r==="estimate"}));const subject=geo.communeCode||geo.communeName;obs.run(`${subject}:${id}:${year}`,String(year),id,parsed.value,unit,geo.geoId,"commune",subject,snap.snapshotId,JSON.stringify({sheet:sheetName,resourceId:resource.id,role:r,year}));written++;local++}}}})();
        resourcesDone++;console.log(`[casen] ✓ ${clean(resource.name)} · observaciones=${local}`)
      }catch(e){failed++;console.error(`[casen] ! ${resource.name}: ${String(e)}`)}updateRunProgress(run,seen,written,`${ri+1}/${resources.length} recursos; ok=${resourcesDone}; failed=${failed}`)
    }
    finishRun(run,resourcesDone?"success":"failed",`resources=${resourcesDone}; failed=${failed}`,seen,written);if(!resourcesDone)throw new Error("No se pudo sincronizar ningún recurso CASEN comunal");return{packages:selected.length,resources:resourcesDone,seen,written,failed}
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
