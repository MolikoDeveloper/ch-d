import * as XLSX from "xlsx";
import { unzipSync } from "fflate";
import { db, updateRunProgress } from "../../db";
import { resolveGeoArea } from "../../geo";
import { fetchAndSnapshot } from "../raw";
import { parseCsv } from "../parsers/tabular";

type Row=Record<string,unknown>;
type MatrixRow=unknown[];
type Resource={url:string;label:string;page:string;office:string;date:string|null;year:number|null;round:number|null;status:"definitive"|"preliminary"};
type Agg={electionId:number;geoId:number;subject:string;candidate:string;party:string|null;coalition:string|null;list:string|null;ballot:string|null;votes:number;elected:boolean|null;snapshotId:number;sourceUrl:string;sourceRows:number};
type Totals={valid:number;nullVotes:number;blankVotes:number;reportedTotal:number|null;snapshotId:number};

const PROCESS_PAGES=[
  "https://www.servel.cl/resultados-preliminares-eleccion-presidencial-y-parlamentarias-2025/",
  "https://www.servel.cl/resultados-preliminares-segunda-votacion/",
  "https://www.servel.cl/biblioteca-de-documentos/procesos-electorales/convencionales-constituyentes-municipales-y-gobernadores-regionales-2021/",
  "https://www.servel.cl/biblioteca-de-documentos/procesos-electorales/presidenciales-parlamentarias-y-consejeros-regionales-2021/",
  "https://www.servel.cl/biblioteca-de-documentos/procesos-electorales/presidenciales-parlamentarias-y-consejeros-regionales-2017/",
  "https://www.servel.cl/biblioteca-de-documentos/procesos-electorales/municipales-2016/",
  "https://www.servel.cl/biblioteca-de-documentos/procesos-electorales/presidenciales-parlamentarias-y-consejeros-regionales-2013/",
  "https://www.servel.cl/biblioteca-de-documentos/procesos-electorales/presidenciales-y-parlamentarias-2009/",
  "https://www.servel.cl/biblioteca-de-documentos/procesos-electorales/presidenciales-y-parlamentarias-2005/",
];

function clean(v:unknown){return String(v??"").replace(/\s+/g," ").trim()}
function norm(v:unknown){return clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9%]+/g," ").replace(/\s+/g," ").trim()}
function htmlText(v:string){return v.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#0*39;|&apos;/gi,"'").replace(/&nbsp;/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()}
function numeric(v:unknown){if(typeof v==="number")return Number.isFinite(v)?v:null;let s=clean(v);if(!s||/^(?:-|—|s\/?i|n\/?a)$/i.test(s))return null;s=s.replace(/%/g,"").replace(/\s/g,"");if(/^[-+]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s))s=s.replace(/\./g,"").replace(",",".");else s=s.replace(",",".");const n=Number(s);return Number.isFinite(n)?n:null}
function hash(value:string){const h=new Bun.CryptoHasher("sha256");h.update(value);return h.digest("hex").slice(0,24)}
function fileFormat(url:string){const p=url.split("?")[0].trim().toLowerCase();if(p.endsWith(".zip"))return"ZIP";if(p.endsWith(".xlsx"))return"XLSX";if(p.endsWith(".xls"))return"XLS";if(p.endsWith(".csv"))return"CSV";if(p.endsWith(".txt"))return"TXT";return""}
function officeFrom(value:string){
  const n=norm(value),matches:Array<{at:number;office:string}>=[];
  const specs:Array<[RegExp,string]>=[
    [/presid(?:ente|encial)/g,"president"],[/senador/g,"senator"],[/diputad/g,"deputy"],[/alcald/g,"mayor"],[/concejal/g,"councillor"],[/gobernador/g,"regional_governor"],[/consejer(?:o|a).*regional|\bcore\b/g,"regional_councillor"],[/constituyente/g,"constituent"],
  ];
  for(const[re,office]of specs)for(const m of n.matchAll(re))matches.push({at:m.index??0,office});
  return matches.sort((a,b)=>b.at-a.at)[0]?.office??"";
}
function roundFrom(v:string){const n=norm(v);if(/segunda (?:eleccion|votacion|vuelta)|2da|2 vuelta/.test(n))return 2;if(/primera (?:eleccion|votacion|vuelta)|1ra|1 vuelta/.test(n))return 1;return null}
function dateFrom(v:string){const m=v.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](20\d{2}|19\d{2})\b/);if(m)return`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;return null}
function yearFrom(v:string){const m=v.match(/\b(20\d{2}|19\d{2})\b/);return m?Number(m[1]):null}
function scopeForOffice(office:string){if(office==="president")return"country";if(office==="senator")return"senatorial_constituency";if(office==="deputy")return"district";if(office==="regional_governor")return"region";if(office==="regional_councillor")return"regional_constituency";return"commune"}
function officeLabel(office:string){return({president:"Presidente/a de la República",senator:"Senador/a",deputy:"Diputado/a",mayor:"Alcalde/Alcaldesa",councillor:"Concejal/a",regional_governor:"Gobernador/a Regional",regional_councillor:"Consejero/a Regional",constituent:"Convencional Constituyente"}as Record<string,string>)[office]??office}

function discoverResources(html:string,page:string){
  const out:Resource[]=[];const resultAt=Math.max(0,html.search(/>\s*(?:Resultados|Resultados Preliminares)[^<]*</i));const body=resultAt?html.slice(resultAt):html;
  for(const m of body.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
    let url:string;try{url=new URL(htmlText(m[1]).trim(),page).toString().trim()}catch{continue}
    const format=fileFormat(url);if(!format)continue;
    const before=htmlText(body.slice(Math.max(0,(m.index??0)-1200),m.index??0)),label=htmlText(m[2]),context=`${before} ${label}`;
    const office=officeFrom(context);if(!office)continue;
    if(/padron|participacion|candidatura|estadistica por|porcentaje de votantes/i.test(label))continue;
    const date=dateFrom(context),year=date?Number(date.slice(0,4)):yearFrom(context)||yearFrom(page),round=roundFrom(context);
    out.push({url:url.replace(/%20$/,""),label:label||url,page,office,date,year,round,status:/preliminar/i.test(`${label} ${page}`)?"preliminary":"definitive"});
  }
  return out;
}

function headerScore(row:MatrixRow){let s=0;for(const v of row){const n=norm(v);if(/candidat|nombres?|apellido/.test(n))s+=5;if(/votos|votacion|preferencias/.test(n))s+=5;if(/comuna|region|distrito|circunscripcion/.test(n))s+=2;if(/partido|pacto|lista/.test(n))s+=1}return s}
function headerIndex(matrix:MatrixRow[]){let best={i:-1,s:0};for(let i=0;i<Math.min(60,matrix.length);i++){const s=headerScore(matrix[i]??[]);if(s>best.s)best={i,s}}return best.s>=8?best.i:-1}
function headers(row:MatrixRow){const seen=new Map<string,number>();return row.map((v,i)=>{const base=clean(v)||`col_${i+1}`,n=(seen.get(base)??0)+1;seen.set(base,n);return n===1?base:`${base} ${n}`})}
function matrixRows(matrix:MatrixRow[]){const hi=headerIndex(matrix);if(hi<0)return[];const hs=headers(matrix[hi]);return matrix.slice(hi+1).filter(r=>r?.some(v=>clean(v))).map(arr=>Object.fromEntries(hs.map((h,i)=>[h,arr[i]??null])) as Row)}
function rowsFromWorkbook(bytes:Uint8Array){const wb=XLSX.read(bytes,{type:"array",cellDates:false,raw:false}),out:Row[]=[];for(const sheet of wb.SheetNames){const matrix=XLSX.utils.sheet_to_json<MatrixRow>(wb.Sheets[sheet],{header:1,defval:null,raw:false})as MatrixRow[];for(const r of matrixRows(matrix))out.push({__sheet:sheet,...r})}return out}
function decode(bytes:Uint8Array){const utf=new TextDecoder("utf-8").decode(bytes);return(utf.match(/�/g)??[]).length<3?utf:new TextDecoder("windows-1252").decode(bytes)}
function rowsFromResource(url:string,bytes:Uint8Array){
  const format=fileFormat(url);if(format==="XLSX"||format==="XLS")return rowsFromWorkbook(bytes);if(format==="CSV"||format==="TXT")return parseCsv(decode(bytes));if(format!=="ZIP")return[];
  const files=unzipSync(bytes),out:Row[]=[];
  for(const[name,data]of Object.entries(files)){
    const f=fileFormat(name);try{if(f==="XLSX"||f==="XLS")out.push(...rowsFromWorkbook(data));else if(f==="CSV"||f==="TXT")out.push(...parseCsv(decode(data)).map(r=>({__archive_file:name,...r})))}catch(e){console.warn(`[servel:results] archivo ${name}: ${String(e)}`)}
  }
  return out;
}
function field(row:Row,test:(key:string)=>boolean){for(const[k,v]of Object.entries(row))if(test(norm(k)))return v;return null}
function candidateName(row:Row){
  const direct=field(row,k=>/candidat/.test(k)&&!/numero|nro|orden|electo/.test(k));if(clean(direct))return clean(direct);
  const names=field(row,k=>k==="nombre"||k==="nombres"||k.includes("nombres candidato")),paternal=field(row,k=>/apellido paterno|primer apellido/.test(k)),maternal=field(row,k=>/apellido materno|segundo apellido/.test(k));
  const joined=[names,paternal,maternal].map(clean).filter(Boolean).join(" ");if(joined)return joined;
  const fallback=field(row,k=>k==="nombre completo"||k==="opcion"||k==="preferencia");return clean(fallback);
}
function votes(row:Row){const direct=field(row,k=>/votos|votacion|preferencias/.test(k)&&!/%|porcentaje|total|valida|nulo|blanco/.test(k));const n=numeric(direct);if(n!=null)return Math.round(n);const fallback=field(row,k=>k==="votos"||k==="votacion");const f=numeric(fallback);return f==null?null:Math.round(f)}
function code(v:unknown,size:number){const s=clean(v).replace(/\.0+$/,"").replace(/\D/g,"");return s?s.padStart(size,"0"):""}
function geo(row:Row){
  const communeCode=field(row,k=>(/codigo|\bcut\b|^cod /.test(k))&&k.includes("comuna")),communeName=field(row,k=>k==="comuna"||k.includes("nombre comuna"));
  const cc=code(communeCode,5),cn=clean(communeName);let geoId=cc?resolveGeoArea(cc,null):cn?resolveGeoArea(null,cn):null;if(geoId)return{geoId,subject:cc||cn};
  const regionCode=field(row,k=>(/codigo|\bcut\b|^cod /.test(k))&&k.includes("region")),regionName=field(row,k=>k==="region"||k.includes("nombre region"));
  const rc=code(regionCode,2),rn=clean(regionName);geoId=rc?resolveGeoArea(rc,null):rn?resolveGeoArea(null,rn):null;return geoId?{geoId,subject:rc||rn}:null;
}
function textField(row:Row,re:RegExp){const v=field(row,k=>re.test(k));return clean(v)||null}
function electedValue(row:Row){const v=textField(row,/elect[oa]|resultado candidatura/);if(!v)return null;const n=norm(v);if(/^(si|electo|electa|elected|1)$/.test(n))return true;if(/^(no|no electo|no electa|0)$/.test(n))return false;return null}
function voteType(name:string){const n=norm(name);if(/votos? nulos?|^nulos?$/.test(n))return"null";if(/votos? blancos?|^blancos?$/.test(n))return"blank";if(/total.*sufrag|total.*vot/.test(n))return"total";if(/validamente emitidos|votos? validos?/.test(n))return"valid";return"candidate"}
function electionExternal(r:Resource){const period=r.date??String(r.year??"unknown");return`servel:${r.office}:${period}:r${r.round??1}`}

function ensureElection(r:Resource,snapshotId:number){
  const external=electionExternal(r),name=`${officeLabel(r.office)} ${r.year??""}${r.round===2?" — segunda vuelta":""}`.replace(/\s+/g," ").trim();
  db.prepare(`INSERT INTO elections(source_id,external_id,name,office_type,election_date,round,territorial_scope,status,source_url,raw_snapshot_id,metadata_json) VALUES('servel',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET name=excluded.name,election_date=COALESCE(excluded.election_date,elections.election_date),round=COALESCE(excluded.round,elections.round),status=CASE WHEN excluded.status='definitive' THEN 'definitive' ELSE elections.status END,source_url=excluded.source_url,raw_snapshot_id=excluded.raw_snapshot_id,metadata_json=excluded.metadata_json`).run(external,name,r.office,r.date??(r.year?String(r.year):null),r.round??1,scopeForOffice(r.office),r.status,r.url,snapshotId,JSON.stringify({page:r.page,label:r.label,year:r.year}));
  return Number((db.query(`SELECT id FROM elections WHERE source_id='servel' AND external_id=?`).get(external)as any).id);
}
function personId(name:string){const external=`candidate:${hash(norm(name))}`;db.prepare(`INSERT INTO persons(canonical_name,source_id,external_id,metadata_json) VALUES(?,'servel',?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET canonical_name=excluded.canonical_name`).run(name,external,JSON.stringify({kind:"election_candidate"}));return Number((db.query(`SELECT id FROM persons WHERE source_id='servel' AND external_id=?`).get(external)as any).id)}
function candidateId(electionId:number,a:Agg){const external=`candidate:${hash(`${norm(a.candidate)}|${norm(a.party)}`)}`,pid=personId(a.candidate);db.prepare(`INSERT INTO election_candidates(election_id,external_id,person_id,candidate_name,party,coalition,list_name,ballot_number,metadata_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(election_id,external_id) DO UPDATE SET person_id=excluded.person_id,candidate_name=excluded.candidate_name,party=COALESCE(excluded.party,election_candidates.party),coalition=COALESCE(excluded.coalition,election_candidates.coalition),list_name=COALESCE(excluded.list_name,election_candidates.list_name),ballot_number=COALESCE(excluded.ballot_number,election_candidates.ballot_number)`).run(electionId,external,pid,a.candidate,a.party,a.coalition,a.list,a.ballot,JSON.stringify({sourceUrl:a.sourceUrl}));return Number((db.query(`SELECT id FROM election_candidates WHERE election_id=? AND external_id=?`).get(electionId,external)as any).id)}

export async function syncServelResults(run:number){
  const pages=(process.env.SERVEL_RESULTS_PAGES??PROCESS_PAGES.join(",")).split(",").map(x=>x.trim()).filter(Boolean),discovered:Resource[]=[];
  console.log(`[servel:results] Descubriendo resultados electorales en ${pages.length} páginas oficiales...`);
  for(let i=0;i<pages.length;i++)try{const snap=await fetchAndSnapshot("servel",run,pages[i]),found=discoverResources(snap.text,pages[i]);discovered.push(...found);console.log(`[servel:results] ${i+1}/${pages.length} ${found.length} recursos · ${pages[i]}`)}catch(e){console.warn(`[servel:results] página ${pages[i]}: ${String(e)}`)}
  const resources=[...new Map(discovered.map(r=>[r.url,r])).values()].slice(0,Math.max(1,Number(process.env.SERVEL_RESULTS_RESOURCE_LIMIT??200)));
  console.log(`[servel:results] ${resources.length} recursos estructurados encontrados`);
  const aggs=new Map<string,Agg>(),totals=new Map<string,Totals>();let seen=0,parsedResources=0,failed=0,unresolved=0;
  for(let i=0;i<resources.length;i++){
    const r=resources[i];try{
      const snap=await fetchAndSnapshot("servel",run,r.url),electionId=ensureElection(r,snap.snapshotId),rows=rowsFromResource(r.url,snap.bytes);let local=0;
      for(const row of rows){seen++;const g=geo(row);if(!g){unresolved++;continue}const name=candidateName(row),v=votes(row);if(!name||v==null||v<0)continue;const type=voteType(name),tkey=`${electionId}|${g.geoId}`,t=totals.get(tkey)??{valid:0,nullVotes:0,blankVotes:0,reportedTotal:null,snapshotId:snap.snapshotId};
        if(type==="null")t.nullVotes+=v;else if(type==="blank")t.blankVotes+=v;else if(type==="total")t.reportedTotal=(t.reportedTotal??0)+v;else if(type==="valid"){/* candidate sum is the canonical valid denominator */}else{
          const party=textField(row,/sigla partido|^partido$|partido politico/),coalition=textField(row,/pacto|coalicion/),list=textField(row,/^lista$|nombre lista/),ballot=textField(row,/numero candidato|nro candidato|numero preferencia|orden candidato/),key=`${electionId}|${g.geoId}|${norm(name)}|${norm(party)}`,a=aggs.get(key)??{electionId,geoId:g.geoId,subject:g.subject,candidate:name,party,coalition,list,ballot,votes:0,elected:null,snapshotId:snap.snapshotId,sourceUrl:r.url,sourceRows:0};a.votes+=v;a.sourceRows++;const ev=electedValue(row);if(ev!=null)a.elected=ev;aggs.set(key,a);t.valid+=v;local++;
        }totals.set(tkey,t);
      }
      parsedResources++;console.log(`[servel:results] ${i+1}/${resources.length} ✓ ${officeLabel(r.office)} ${r.year??""} · filas=${rows.length} candidaturas=${local}`)
    }catch(e){failed++;console.warn(`[servel:results] ${i+1}/${resources.length} ! ${r.label}: ${String(e)}`)}
    updateRunProgress(run,seen,aggs.size,`resultados ${i+1}/${resources.length}; recursos_ok=${parsedResources}; candidaturas_territoriales=${aggs.size}; unresolved=${unresolved}; failed=${failed}`)
  }
  const byTerritory=new Map<string,Agg[]>();for(const a of aggs.values()){const k=`${a.electionId}|${a.geoId}`,list=byTerritory.get(k)??[];list.push(a);byTerritory.set(k,list)}
  let written=0;
  db.transaction(()=>{
    const result=db.prepare(`INSERT INTO election_results(election_id,candidate_id,geo_area_id,votes,valid_vote_pct,total_vote_pct,position,elected,raw_snapshot_id,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(election_id,candidate_id,geo_area_id) DO UPDATE SET votes=excluded.votes,valid_vote_pct=excluded.valid_vote_pct,total_vote_pct=excluded.total_vote_pct,position=excluded.position,elected=COALESCE(excluded.elected,election_results.elected),raw_snapshot_id=excluded.raw_snapshot_id,metadata_json=excluded.metadata_json`);
    const totalStmt=db.prepare(`INSERT INTO election_totals(election_id,geo_area_id,valid_votes,null_votes,blank_votes,total_votes,registered_voters,turnout_pct,raw_snapshot_id,metadata_json) VALUES(?,?,?,?,?,?,NULL,NULL,?,?) ON CONFLICT(election_id,geo_area_id) DO UPDATE SET valid_votes=excluded.valid_votes,null_votes=excluded.null_votes,blank_votes=excluded.blank_votes,total_votes=excluded.total_votes,raw_snapshot_id=excluded.raw_snapshot_id,metadata_json=excluded.metadata_json`);
    for(const[k,list]of byTerritory){list.sort((a,b)=>b.votes-a.votes||a.candidate.localeCompare(b.candidate,"es-CL"));const[electionId,geoId]=k.split("|").map(Number),t=totals.get(k)??{valid:list.reduce((s,a)=>s+a.votes,0),nullVotes:0,blankVotes:0,reportedTotal:null,snapshotId:list[0].snapshotId},valid=list.reduce((s,a)=>s+a.votes,0),calculatedTotal=valid+t.nullVotes+t.blankVotes,total=t.reportedTotal&&t.reportedTotal>=calculatedTotal?t.reportedTotal:calculatedTotal;
      totalStmt.run(electionId,geoId,valid,t.nullVotes||null,t.blankVotes||null,total||null,t.snapshotId,JSON.stringify({denominator:"candidate_votes",reportedTotal:t.reportedTotal}));
      for(let i=0;i<list.length;i++){const a=list[i],cid=candidateId(electionId,a),validPct=valid>0?a.votes/valid*100:null,totalPct=total>0?a.votes/total*100:null;result.run(electionId,cid,geoId,a.votes,validPct,totalPct,i+1,a.elected==null?null:a.elected?1:0,a.snapshotId,JSON.stringify({sourceUrl:a.sourceUrl,sourceRows:a.sourceRows}));written++}
    }
  })();
  return{pages:pages.length,resources:resources.length,parsedResources,seen,written,unresolved,failed};
}
