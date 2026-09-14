import { db, finishRun, startRun, updateRunProgress } from "../../db";
import { resolveGeoArea } from "../../geo";
import { fetchAndSnapshot } from "../raw";
import { parseResource } from "../parsers/tabular";

type Row=Record<string,unknown>;
type Link={url:string;text:string;year:number|null};
const HUB="https://www.servel.cl/elecciones-participacion-electoral/";

function decode(s:string){return s.replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#0*39;|&apos;/gi,"'").replace(/&nbsp;/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()}
function norm(v:unknown){return String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9%]+/g," ").replace(/\s+/g," ").trim()}
function clean(v:unknown){return String(v??"").replace(/\s+/g," ").trim()}
function numeric(v:unknown){if(typeof v==="number")return Number.isFinite(v)?v:null;let s=clean(v);if(!s||/^[-*]+$/.test(s))return null;const pct=s.includes("%");s=s.replace(/%/g,"").replace(/\.(?=\d{3}(?:\D|$))/g,"").replace(",",".");const n=Number(s);return Number.isFinite(n)?{value:n,pct}:null}
function nearestYear(html:string,at:number){const before=decode(html.slice(Math.max(0,at-1800),at)),all=[...before.matchAll(/\b(20\d{2}|201\d)\b/g)];return all.length?Number(all.at(-1)![1]):null}
function anchors(html:string,base:string,inheritYear:number|null=null){const out:Link[]=[];for(const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){try{out.push({url:new URL(decode(m[1]),base).toString(),text:decode(m[2]),year:inheritYear??nearestYear(html,m.index??0)})}catch{}}return out}
function yearOf(...values:string[]){for(const v of values){const m=v.match(/\b(20\d{2}|201\d)\b/);if(m)return Number(m[1])}return null}
function format(url:string){const p=new URL(url).pathname.toLowerCase();if(p.endsWith(".xlsx"))return"XLSX";if(p.endsWith(".xls"))return"XLS";if(p.endsWith(".csv"))return"CSV";if(p.endsWith(".zip"))return"ZIP";if(p.endsWith(".txt"))return"TXT";return""}
function code(v:unknown){const s=clean(v).replace(/\.0+$/,"").replace(/\D/g,"");return s.length>=4&&s.length<=5?s.padStart(5,"0"):""}
function field(row:Row,test:(k:string)=>boolean){for(const[k,v]of Object.entries(row))if(test(norm(k)))return v;return null}
function commune(row:Row){const c=field(row,k=>(k.includes("codigo")||k.startsWith("cod")||k.includes("cut"))&&k.includes("comuna"));const n=field(row,k=>k==="comuna"||k.includes("nombre comuna"));const cc=code(c),name=clean(n);return{code:cc,name,geoId:cc?resolveGeoArea(cc,null):name?resolveGeoArea(`Comuna de ${name}`,null):null}}
function isGeoOrDimension(h:string){const n=norm(h);return /region|comuna|provincia|codigo|cut|sexo|edad|rango etario|nacionalidad|partido|pacto/.test(n)}
function isParticipation(h:string){const n=norm(h);return /particip|sufrag|votantes|votos emitidos|electores|padron|habilitados|abstencion/.test(n)}
function unit(h:string,raw:unknown){return clean(raw).includes("%")||norm(h).includes("porcentaje")||norm(h).includes("tasa")?"%":"N°"}
function metricId(header:string,process:string){const h=new Bun.CryptoHasher("sha256");h.update(`${norm(process).replace(/\b20\d{2}\b/g,"")}:${norm(header)}`);return`servel:${h.digest("hex").slice(0,24)}`}

export async function syncServel(){
  const run=startRun("servel");let seen=0,written=0,failed=0,pages=0,resourcesDone=0;
  try{
    console.log("[servel] Descubriendo estadísticas oficiales de participación por comuna...");
    const hub=await fetchAndSnapshot("servel",run,HUB);
    const pageLinks=anchors(hub.text,HUB).filter(l=>l.url.includes("servel.cl/")&&/comuna/i.test(l.text)&&!/sexo|rango|edad|nacionalidad|extranj/i.test(l.text));
    const uniquePages=[...new Map(pageLinks.map(x=>[`${x.url}:${x.year??""}`,x])).values()].slice(0,Number(process.env.SERVEL_PAGE_LIMIT??50));
    const resources:Array<{url:string;text:string;page:string;process:string;year:number|null}>=[];
    for(let i=0;i<uniquePages.length;i++){
      const page=uniquePages[i];try{const snap=await fetchAndSnapshot("servel",run,page.url);pages++;for(const l of anchors(snap.text,page.url,page.year)){const f=format(l.url);if(f&&/\.(?:xlsx?|csv|zip|txt)(?:\?|$)/i.test(l.url))resources.push({url:l.url,text:l.text||l.url,page:page.url,process:page.text,year:l.year})}}catch(e){console.error(`[servel] página ${page.url}: ${String(e)}`)}
    }
    const selected=[...new Map(resources.map(r=>[`${r.url}:${r.year??""}`,r])).values()].slice(0,Number(process.env.SERVEL_RESOURCE_LIMIT??100));
    console.log(`[servel] páginas=${pages} · recursos tabulares=${selected.length}`);
    const metric=db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json) VALUES('servel',?,?,?,?,?,?,?,'commune',?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,unit=excluded.unit,metadata_json=excluded.metadata_json`);
    const obs=db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json) VALUES('servel',?,?,?,?,NULL,?,?,?,?,?,?) ON CONFLICT(source_id,external_id,metric) DO UPDATE SET value_number=excluded.value_number,unit=excluded.unit,geo_area_id=excluded.geo_area_id,raw_snapshot_id=excluded.raw_snapshot_id,payload_json=excluded.payload_json`);
    for(let i=0;i<selected.length;i++){
      const r=selected[i];try{
        const f=format(r.url),snap=await fetchAndSnapshot("servel",run,r.url),parsed=parseResource(f,snap.bytes,snap.text),y=r.year??yearOf(r.process,r.text,r.url);if(!y){console.warn(`[servel] sin año, omitido: ${r.text}`);continue}let local=0;
        db.transaction(()=>{for(const row of parsed){if((row as any).__parse_error)continue;seen++;const geo=commune(row);if(!geo.geoId)continue;for(const[header,raw]of Object.entries(row)){if(isGeoOrDimension(header)||!isParticipation(header))continue;const n=numeric(raw);if(!n)continue;const u=unit(header,raw),id=metricId(header,r.process);
          metric.run(id,clean(header),`Estadística oficial de participación electoral: ${r.process}.`,"elecciones",r.process,u,"event",JSON.stringify({page:r.page,resource:r.url,year:y,mapEligible:true}));
          obs.run(`${geo.code||geo.name}:${id}:${y}`,String(y),id,n.value,u,geo.geoId,"commune",geo.code||geo.name,snap.snapshotId,JSON.stringify({process:r.process,resource:r.text,year:y}));written++;local++}}})();resourcesDone++;console.log(`[servel] ${i+1}/${selected.length} ✓ ${y} · ${r.process} · obs=${local}`)
      }catch(e){failed++;console.error(`[servel] ${i+1}/${selected.length} ! ${r.text}: ${String(e)}`)}updateRunProgress(run,seen,written,`${i+1}/${selected.length} recursos; ok=${resourcesDone}; failed=${failed}`)
    }
    finishRun(run,resourcesDone?"success":"failed",`pages=${pages}; resources=${resourcesDone}; failed=${failed}`,seen,written);if(!resourcesDone)throw new Error("No se encontraron recursos SERVEL tabulares procesables");return{pages,resources:resourcesDone,seen,written,failed};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
