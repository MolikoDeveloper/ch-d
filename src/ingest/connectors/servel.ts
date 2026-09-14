import * as XLSX from "xlsx";
import { db, finishRun, startRun, updateRunProgress } from "../../db";
import { resolveGeoArea } from "../../geo";
import { fetchAndSnapshot } from "../raw";

type MatrixRow=unknown[];
type DataRow=Record<string,unknown>;

const STATS_PAGE="https://www.servel.cl/biblioteca-de-documentos/estadisticas/estadisticas-globales-del-padron-electoral/";
const FALLBACK_XLSX="https://www.servel.cl/wp-content/uploads/2026/03/ESTADISTICAS-PADRON-ELECTORAL-HISTORICO-NACIONAL.xlsx";

function clean(v:unknown){return String(v??"").replace(/\s+/g," ").trim()}
function norm(v:unknown){return clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim()}
function numeric(v:unknown){if(typeof v==="number")return Number.isFinite(v)?v:null;const s=clean(v).replace(/\s/g,"").replace(/\.(?=\d{3}(?:\D|$))/g,"").replace(",",".");if(!s||/^(?:-|s\/?i|n\/?a)$/i.test(s))return null;const n=Number(s);return Number.isFinite(n)?n:null}
function code(v:unknown){const s=clean(v).replace(/\.0+$/,"").replace(/\D/g,"");return s.length>=4&&s.length<=5?s.padStart(5,"0"):""}
function decodeHtml(v:string){return v.replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#0*39;|&apos;/gi,"'").replace(/&nbsp;/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()}
function workbookUrl(html:string){
  for(const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
    const text=norm(decodeHtml(m[2]));
    if(/cantidad de electores.*chile.*comuna/.test(text)&&/\.xlsx(?:\?|$)/i.test(m[1]))try{return new URL(decodeHtml(m[1]),STATS_PAGE).toString()}catch{}
  }
  const direct=html.match(/https?:\/\/[^"'<>\s]+ESTADISTICAS-PADRON-ELECTORAL-HISTORICO-NACIONAL\.xlsx/i)?.[0];
  return direct??FALLBACK_XLSX;
}
function headerScore(row:MatrixRow){let s=0;for(const v of row){const n=norm(v);if(n.includes("comuna"))s+=6;if(/elector|cantidad|total/.test(n))s+=3;if(/eleccion|plebiscito|proceso|fecha/.test(n))s+=2;if(/sexo|edad|nacionalidad/.test(n))s+=1}return s}
function headerIndex(rows:MatrixRow[]){let best={i:-1,s:0};for(let i=0;i<Math.min(50,rows.length);i++){const s=headerScore(rows[i]??[]);if(s>best.s)best={i,s}}return best.s>=6?best.i:-1}
function headers(row:MatrixRow){const used=new Map<string,number>();return row.map((v,i)=>{const base=clean(v)||`col_${i+1}`,n=(used.get(base)??0)+1;used.set(base,n);return n===1?base:`${base} ${n}`})}
function field(row:DataRow,test:(k:string)=>boolean){for(const[k,v]of Object.entries(row))if(test(norm(k)))return v;return null}
function commune(row:DataRow){
  const c=field(row,k=>(/codigo|^cod |^cut /.test(k)||k==="codigo"||k==="cut")&&k.includes("comuna"));
  const genericCode=c??field(row,k=>k==="codigo"||k==="cut");
  const n=field(row,k=>k==="comuna"||k.includes("nombre comuna")||k.endsWith(" comuna"));
  const cc=code(genericCode),name=clean(n);
  return{code:cc,name,geoId:cc?resolveGeoArea(cc,null):name?resolveGeoArea(null,name):null};
}
function yearIn(...values:unknown[]){for(const v of values){const m=clean(v).match(/\b(20\d{2}|201\d)\b/);if(m)return Number(m[1])}return null}
function processValue(row:DataRow,sheet:string){const v=field(row,k=>/eleccion|plebiscito|proceso electoral|evento electoral/.test(k));return clean(v)||sheet}
function dimensionEntries(row:DataRow){return Object.entries(row).filter(([k])=>/sexo|genero|rango etario|edad|nacionalidad/.test(norm(k)))}
function isTotal(v:unknown){return !clean(v)||/^(?:total|todos?|todas?|ambos?|t)$/i.test(clean(v))}
function measure(row:DataRow){
  const entries=Object.entries(row).filter(([k])=>{const n=norm(k);return !/porcentaje|tasa|codigo|ano|fecha/.test(n)&&/total.*elector|elector.*total|cantidad.*elector|numero.*elector|electores|cantidad/.test(n)});
  const total=entries.find(([k])=>norm(k).includes("total"));if(total){const n=numeric(total[1]);if(n!=null)return n}
  const nums=entries.map(([,v])=>numeric(v)).filter((v):v is number=>v!=null);return nums.length?nums.reduce((a,b)=>a+b,0):null;
}
function wideMeasures(row:DataRow){return Object.entries(row).flatMap(([k,v])=>{const y=yearIn(k),n=numeric(v);return y&&n!=null&&!/codigo|region|provincia|comuna/.test(norm(k))?[{process:clean(k),year:y,value:n}]:[]})}
function metricId(process:string){const h=new Bun.CryptoHasher("sha256");h.update(norm(process));return`servel:padron:${h.digest("hex").slice(0,20)}`}

export async function syncServel(){
  const run=startRun("servel");let seen=0,written=0,unresolved=0;
  try{
    console.log("[servel] Descubriendo padrón electoral histórico oficial...");
    const page=await fetchAndSnapshot("servel",run,STATS_PAGE),url=workbookUrl(page.text);
    console.log(`[servel] XLSX: ${url}`);
    const snap=await fetchAndSnapshot("servel",run,url),wb=XLSX.read(snap.bytes,{type:"array",cellDates:false,raw:false});
    const groups=new Map<string,{geoId:number;subject:string;process:string;year:number;total:number[];leaf:number;rows:number}>();
    for(let si=0;si<wb.SheetNames.length;si++){
      const sheet=wb.SheetNames[si],matrix=XLSX.utils.sheet_to_json<MatrixRow>(wb.Sheets[sheet],{header:1,defval:null,raw:false})as MatrixRow[],hi=headerIndex(matrix);
      if(hi<0){console.log(`[servel] ${sheet}: sin cabecera comunal reconocible`);continue}
      const hs=headers(matrix[hi]);let sheetRows=0;
      for(const arr of matrix.slice(hi+1)){
        if(!arr?.some(v=>clean(v)))continue;seen++;const row=Object.fromEntries(hs.map((h,i)=>[h,arr[i]??null])) as DataRow,geo=commune(row);if(!geo.geoId){unresolved++;continue}
        const wide=wideMeasures(row);
        if(wide.length){for(const w of wide){const key=`${geo.geoId}|${w.process}`,g=groups.get(key)??{geoId:geo.geoId,subject:geo.code||geo.name,process:w.process,year:w.year,total:[],leaf:0,rows:0};g.total.push(w.value);g.rows++;groups.set(key,g);sheetRows++}continue}
        const process=processValue(row,sheet),year=yearIn(process,field(row,k=>/ano|fecha/.test(k)),sheet);if(!year)continue;const value=measure(row);if(value==null)continue;
        const dims=dimensionEntries(row),allTotal=dims.length===0||dims.every(([,v])=>isTotal(v)),leaf=dims.length===0||dims.every(([,v])=>!isTotal(v));
        const key=`${geo.geoId}|${process}`,g=groups.get(key)??{geoId:geo.geoId,subject:geo.code||geo.name,process,year,total:[],leaf:0,rows:0};
        if(allTotal)g.total.push(value);else if(leaf)g.leaf+=value;g.rows++;groups.set(key,g);sheetRows++;
      }
      console.log(`[servel] ${si+1}/${wb.SheetNames.length} ${sheet} · filas útiles=${sheetRows}`);updateRunProgress(run,seen,written,`${si+1}/${wb.SheetNames.length} hojas; grupos=${groups.size}; comunas_sin_resolver=${unresolved}`)
    }
    const metric=db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json) VALUES('servel',?,?,?,?,?,?,?,'commune',?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,description=excluded.description,subcategory=excluded.subcategory,unit=excluded.unit,metadata_json=excluded.metadata_json`);
    const obs=db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json) VALUES('servel',?,?,?,?,NULL,?,?,?,?,?,?) ON CONFLICT(source_id,external_id,metric) DO UPDATE SET observed_at=excluded.observed_at,value_number=excluded.value_number,unit=excluded.unit,geo_area_id=excluded.geo_area_id,raw_snapshot_id=excluded.raw_snapshot_id,payload_json=excluded.payload_json`);
    db.transaction(()=>{for(const g of groups.values()){const value=g.total.length?Math.max(...g.total):g.leaf;if(!Number.isFinite(value)||value<=0)continue;const id=metricId(g.process);metric.run(id,`Electores habilitados — ${g.process}`,"Cantidad de electores habilitados para sufragar según padrón electoral definitivo de SERVEL.","elecciones","Padrón electoral","N°","event",JSON.stringify({process:g.process,year:g.year,sourceUrl:url,mapEligible:true}));obs.run(`${g.subject}:${id}:${g.year}`,String(g.year),id,value,"N°",g.geoId,"commune",g.subject,snap.snapshotId,JSON.stringify({process:g.process,year:g.year,sourceUrl:url,sourceRows:g.rows}));written++}})();
    finishRun(run,written?"success":"failed",`groups=${groups.size}; unresolved=${unresolved}; observations=${written}`,seen,written);if(!written)throw new Error(`SERVEL no produjo observaciones del padrón; hojas=${wb.SheetNames.length} filas=${seen} sin_resolver=${unresolved}`);return{worksheets:wb.SheetNames.length,seen,written,unresolved,groups:groups.size};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
