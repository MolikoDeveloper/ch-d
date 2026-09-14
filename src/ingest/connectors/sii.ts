import * as XLSX from "xlsx";
import { db, finishRun, startRun, updateRunProgress } from "../../db";
import { resolveGeoArea } from "../../geo";
import { fetchAndSnapshot } from "../raw";

type Row=unknown[];
type RecordRow=Record<string,unknown>;
const URL="https://www.sii.cl/sobre_el_sii/empresas/PUB_COMU.xlsb";

function norm(v:unknown){return String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim()}
function clean(v:unknown){return String(v??"").replace(/\s+/g," ").trim()}
function numeric(v:unknown){
  if(typeof v==="number")return Number.isFinite(v)?v:null;
  const raw=clean(v);if(!raw||raw==="*"||/^s\/?i$/i.test(raw))return null;
  let s=raw.replace(/\s/g,"");
  if(/^[-+]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s))s=s.replace(/\./g,"").replace(",",".");
  else if(/^[-+]?\d+(?:,\d+)?$/.test(s))s=s.replace(",",".");
  const n=Number(s);return Number.isFinite(n)?n:null;
}
function year(row:RecordRow){for(const[k,v]of Object.entries(row)){const n=norm(k);if(n==="ano comercial"||n==="ano tributario"||n==="ano"){const y=Number(clean(v).replace(/\D/g,""));if(y>=2000&&y<=2100)return y}}return null}
function communeName(row:RecordRow){for(const[k,v]of Object.entries(row)){const n=norm(k);if(n==="comuna"||n.includes("comuna del domicilio")||n.includes("comuna casa matriz")){const name=clean(v);if(name&&!/^(?:total|chile)$/i.test(name))return name}}return""}
function resolveCommune(row:RecordRow){const name=communeName(row);return{name,geoId:name?resolveGeoArea(null,`Comuna de ${name}`):null}}
function isDimension(h:string){const n=norm(h);return n==="ano comercial"||n==="ano tributario"||n==="ano"||n.includes("comuna")||n.includes("provincia")||n.includes("region")}
function unit(header:string){const n=norm(header);if(n.includes("ventas")&&n.includes("uf"))return"UF";if((n.includes("renta")||n.includes("remuner"))&&n.includes("uf"))return"UF";if(n.includes("numero")||n.includes("trabajador")||n.includes("empresa")||n.includes("ponderados"))return"N°";return null}
function metricId(header:string){const h=new Bun.CryptoHasher("sha256");h.update(norm(header));return`sii:${h.digest("hex").slice(0,24)}`}
function headerScore(row:Row){let score=0;for(const c of row){const n=norm(c);if(n==="ano comercial")score+=6;if(n.includes("comuna del domicilio")||n==="comuna")score+=8;if(n.includes("numero de empresas"))score+=5;if(n.includes("ventas anuales"))score+=4;if(n.includes("trabajadores dependientes"))score+=4;if(n.includes("renta neta"))score+=3}return score}
function findHeader(matrix:Row[]){let best={at:-1,score:0};for(let i=0;i<Math.min(40,matrix.length);i++){const score=headerScore(matrix[i]??[]);if(score>best.score)best={at:i,score}}return best.score>=14?best.at:-1}
function headers(row:Row){const seen=new Map<string,number>();return row.map((v,i)=>{let h=clean(v)||`col_${i+1}`;const n=(seen.get(h)??0)+1;seen.set(h,n);if(n>1)h=`${h} ${n}`;return h})}

export async function syncSii(){
  const run=startRun("sii");let seen=0,written=0,failed=0,resolved=0;
  try{
    console.log("[sii] Descargando Estadísticas de Empresas por Comuna (PUB_COMU.xlsb)...");
    const snap=await fetchAndSnapshot("sii",run,URL),wb=XLSX.read(snap.bytes,{type:"array",cellDates:false,raw:false});
    const metric=db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json) VALUES('sii',?,?,?,?,?,?,?,'commune',?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,unit=excluded.unit,metadata_json=excluded.metadata_json`);
    const obs=db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json) VALUES('sii',?,?,?,?,NULL,?,?,?,?,?,?) ON CONFLICT(source_id,external_id,metric) DO UPDATE SET observed_at=excluded.observed_at,value_number=excluded.value_number,unit=excluded.unit,geo_area_id=excluded.geo_area_id,raw_snapshot_id=excluded.raw_snapshot_id,payload_json=excluded.payload_json`);
    let processedSheets=0;
    for(let si=0;si<wb.SheetNames.length;si++){
      const sheetName=wb.SheetNames[si],matrix=XLSX.utils.sheet_to_json<Row>(wb.Sheets[sheetName],{header:1,defval:null,raw:false})as Row[],hi=findHeader(matrix);
      if(hi<0)continue;processedSheets++;
      const hs=headers(matrix[hi]);let local=0,localResolved=0;
      console.log(`[sii] hoja ${sheetName} · cabecera fila ${hi+1} · ${matrix.length-hi-1} filas`);
      db.transaction(()=>{
        for(const arr of matrix.slice(hi+1)){
          if(!arr?.some(v=>clean(v)))continue;
          const row=Object.fromEntries(hs.map((h,i)=>[h,arr[i]??null]))as RecordRow;seen++;
          const y=year(row),geo=resolveCommune(row);if(!y||!geo.geoId)continue;resolved++;localResolved++;
          for(const[header,raw]of Object.entries(row)){
            if(isDimension(header))continue;const value=numeric(raw);if(value==null)continue;const id=metricId(header),u=unit(header);
            if(!u)continue;
            metric.run(id,clean(header),"Estadísticas de Empresas del Servicio de Impuestos Internos. Valores suprimidos por reserva tributaria no son imputados.","economia","Empresas por comuna",u,"annual",JSON.stringify({sourceFile:"PUB_COMU.xlsb",sourceUrl:URL,mapEligible:true,privacySuppression:"* = valor no publicable por reserva tributaria",methodology:"Domicilio/casa matriz informado al SII"}));
            obs.run(`${geo.name}:${id}:${y}`,String(y),id,value,u,geo.geoId,"commune",geo.name,snap.snapshotId,JSON.stringify({sourceFile:"PUB_COMU.xlsb",sheet:sheetName,year:y}));written++;local++;
          }
        }
      })();
      console.log(`[sii] ✓ ${sheetName} · comunas/años resueltos=${localResolved} · observaciones=${local}`);
      updateRunProgress(run,seen,written,`${si+1}/${wb.SheetNames.length} hojas; resueltos=${resolved}; failed=${failed}`)
    }
    if(!processedSheets)throw new Error(`PUB_COMU.xlsb descargado, pero ninguna hoja tiene la estructura comunal esperada; hojas=${wb.SheetNames.join(", ")}`);
    if(!written)throw new Error(`SII reconoció la tabla, pero no produjo observaciones; filas=${seen}, territorios resueltos=${resolved}`);
    finishRun(run,"success",`sheets=${processedSheets}; resolved=${resolved}; observations=${written}`,seen,written);
    return{sheets:processedSheets,seen,written,resolved,failed};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
