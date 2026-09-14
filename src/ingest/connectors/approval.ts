import { db, finishRun, startRun, updateRunProgress } from "../../db";
import { countryGeoAreaId } from "../../geo";
import { fetchAndSnapshot } from "../raw";

type Pollster="criteria"|"cadem";
type Entry={pollster:Pollster;date:string;url:string;title:string;approval:number|null;disapproval:number|null;subject:string|null;methodology:string};

const SOURCES={
  criteria:{name:"Agenda Criteria",institution:"Criteria",base:"https://www.criteria.cl",index:"https://www.criteria.cl/archivos-agenda-criteria/",methodology:"Encuesta de opinión pública. Panel online; muestreo aleatorio estratificado por cuotas y resultados ponderados según ficha metodológica de Criteria."},
  cadem:{name:"Plaza Pública Cadem",institution:"Cadem",base:"https://cadem.cl",index:"https://cadem.cl/contenido/plaza-publica/",methodology:"Encuesta de opinión pública Plaza Pública. Desde marzo de 2026 Cadem informa levantamiento mediante panel web; la metodología histórica puede variar por período."},
} as const;

function clean(v:string){return v.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&#0*39;|&apos;/gi,"'").replace(/&quot;/gi,'"').replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()}
function norm(v:string){return clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/\s+/g," ").trim()}
function absolute(base:string,href:string){try{return new URL(href.replace(/&amp;/g,"&"),base).toString()}catch{return null}}
function links(html:string,base:string){const out:Array<{url:string;text:string}>=[];for(const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){const url=absolute(base,m[1]);if(url)out.push({url,text:clean(m[2])})}return out}
const MONTHS:Record<string,string>={enero:"01",febrero:"02",marzo:"03",abril:"04",mayo:"05",junio:"06",julio:"07",agosto:"08",septiembre:"09",setiembre:"09",octubre:"10",noviembre:"11",diciembre:"12"};
function dateFrom(text:string){const n=norm(text);let m=n.match(/\b(\d{1,2})\s+(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+(?:de\s+)?(20\d{2})\b/);if(m)return`${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2,"0")}`;m=n.match(/\b(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})\b/);if(m)return`${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;return null}
function percentage(text:string,patterns:RegExp[]){const n=norm(text);for(const re of patterns){const m=n.match(re);if(m){const value=Number(String(m[1]).replace(",","."));if(Number.isFinite(value)&&value>=0&&value<=100)return value}}return null}
function measures(text:string,pollster:Pollster){
  const approval=percentage(text,[/aprobacion(?:\s+del?|\s+de)?[^%.]{0,100}?(?:a|en|alcanza|alcanzo|situa(?:ndose)? en|registra)?\s*(\d{1,3}(?:[.,]\d+)?)\s*%/,/aprueba(?:n)?[^%.]{0,80}?(\d{1,3}(?:[.,]\d+)?)\s*%/,/(\d{1,3}(?:[.,]\d+)?)\s*%\s+(?:aprueba|de aprobacion)/]);
  const disapproval=percentage(text,[/desaprobacion(?:\s+del?|\s+de)?[^%.]{0,100}?(?:a|en|alcanza|alcanzo|sube|baja|situa(?:ndose)? en)?\s*(\d{1,3}(?:[.,]\d+)?)\s*%/,/(\d{1,3}(?:[.,]\d+)?)\s*%\s+desaprueba/,/desaprueba(?:n)?[^%.]{0,80}?(\d{1,3}(?:[.,]\d+)?)\s*%/]);
  const subjectMatch=clean(text).match(/Presidente\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.-]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.-]+){0,3})/);return{approval,disapproval,subject:subjectMatch?.[1]??null,pollster};
}
function ensureSources(){for(const[id,s]of Object.entries(SOURCES)){db.prepare(`INSERT INTO sources(id,name,institution,domain,base_url,auth_kind,automatic,metadata_json) VALUES(?,?,?,?,?,'none',1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,institution=excluded.institution,domain=excluded.domain,base_url=excluded.base_url,automatic=1,metadata_json=excluded.metadata_json`).run(id,s.name,s.institution,"opinion-publica",s.base,JSON.stringify({kind:"survey",official:false,methodology:s.methodology}))}}
function upsertMetric(pollster:Pollster,kind:"approval"|"disapproval"){
  const id=`${pollster}:presidential_${kind}_pct`,s=SOURCES[pollster],title=kind==="approval"?`Aprobación presidencial — ${s.name}`:`Desaprobación presidencial — ${s.name}`;
  db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json) VALUES(?,?,?,?,?,?,?,'country',?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,description=excluded.description,metadata_json=excluded.metadata_json`).run(pollster,id,title,`Medición de encuesta publicada por ${s.name}. No es una estadística oficial ni un resultado electoral.`,"opinion-publica","Aprobación presidencial","%","weekly",JSON.stringify({survey:true,official:false,methodology:s.methodology,mapEligible:false}));return id
}

async function discover(pollster:Pollster,run:number){
  const s=SOURCES[pollster],snap=await fetchAndSnapshot(pollster,run,s.index),all=links(snap.text,s.base),seen=new Set<string>(),urls:string[]=[];
  for(const l of all){const u=l.url;if(seen.has(u))continue;const n=norm(`${l.text} ${u}`);if(pollster==="criteria"?!/agenda[- /]|agenda criteria/.test(n):!/plaza publica|estudio/.test(n))continue;if(/\.pdf(?:\?|$)/i.test(u))continue;seen.add(u);urls.push(u)}
  const limit=Math.max(1,Number(process.env.APPROVAL_PAGE_LIMIT??60));return urls.slice(0,limit)
}
async function parseEntry(pollster:Pollster,url:string,run:number):Promise<Entry|null>{const snap=await fetchAndSnapshot(pollster,run,url),text=clean(snap.text),date=dateFrom(text)||dateFrom(url);if(!date)return null;const m=measures(text,pollster);if(m.approval==null&&m.disapproval==null)return null;return{pollster,date,url,title:text.slice(0,180),approval:m.approval,disapproval:m.disapproval,subject:m.subject,methodology:SOURCES[pollster].methodology}}

export async function syncApproval(){
  ensureSources();const run=startRun("criteria");let seen=0,written=0,failed=0;const country=countryGeoAreaId();
  try{
    for(const pollster of Object.keys(SOURCES) as Pollster[]){
      const urls=await discover(pollster,run);console.log(`[approval] ${pollster}: ${urls.length} publicaciones candidatas`);const approvalMetric=upsertMetric(pollster,"approval"),disapprovalMetric=upsertMetric(pollster,"disapproval");
      for(let i=0;i<urls.length;i++){try{const entry=await parseEntry(pollster,urls[i],run);seen++;if(!entry)continue;const payload=JSON.stringify({pollster,date:entry.date,subject:entry.subject,sourceUrl:entry.url,methodology:entry.methodology,official:false});const stmt=db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json) VALUES(?,?,?,?,?,NULL,'%',?,'office','president',NULL,?) ON CONFLICT(source_id,external_id,metric) DO UPDATE SET value_number=excluded.value_number,payload_json=excluded.payload_json`);if(entry.approval!=null){stmt.run(pollster,`${pollster}:${entry.date}:approval`,entry.date,approvalMetric,entry.approval,country,payload);written++}if(entry.disapproval!=null){stmt.run(pollster,`${pollster}:${entry.date}:disapproval`,entry.date,disapprovalMetric,entry.disapproval,country,payload);written++}}catch(e){failed++;console.warn(`[approval] ${pollster} ${urls[i]}: ${String(e)}`)}if((i+1)%10===0)updateRunProgress(run,seen,written,`${pollster} ${i+1}/${urls.length}; failed=${failed}`)}
    }
    finishRun(run,written?"success":"failed",`observations=${written}; failed=${failed}`,seen,written);if(!written)throw new Error("Encuestas de aprobación: no se pudieron normalizar mediciones");return{seen,written,failed};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
