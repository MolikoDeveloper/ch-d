import { db, finishRun, startRun, updateRunProgress } from "../../db";
import { fetchAndSnapshot } from "../raw";

const BASE="https://api.presupuestoabierto.gob.cl/institutions";
function text(v:string){return v.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&#0*39;/g,"'").replace(/\s+/g," ").trim()}
function norm(v:string){return v.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}
function num(v:string){const s=v.replace(/[$%\s]/g,"").replace(/\.(?=\d{3}(?:\D|$))/g,"").replace(",",".");const n=Number(s);return Number.isFinite(n)?n:null}
function selectedYear(html:string,fallback:number){const a=html.match(/<option[^>]+value=["']?(20\d{2})["']?[^>]*selected/i)?.[1];const b=html.match(/Año[\s\S]{0,600}?value=["']?(20\d{2})["']?[^>]*selected/i)?.[1];return Number(a??b??fallback)}
function tableRows(html:string){const out:string[][]=[];for(const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){const cells=[...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m=>text(m[1]));if(cells.length>=6)out.push(cells)}return out}
function oid(institution:string,service:string,area:string){const h=new Bun.CryptoHasher("sha256");h.update(`${institution}|${service}|${area}`);return`pa:${h.digest("hex").slice(0,24)}`}

export async function syncPresupuestoAbierto(){
  const run=startRun("presupuesto-abierto");let seen=0,written=0,failed=0;
  try{
    const requested=(process.env.PRESUPUESTO_ABIERTO_YEARS??String(new Date().getFullYear())).split(",").map(x=>Number(x.trim())).filter(y=>y>=2016&&y<=2100);
    const org=db.prepare(`INSERT INTO organizations(canonical_name,organization_type,source_id,external_id,metadata_json) VALUES(?,'public_body','presupuesto-abierto',?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET canonical_name=excluded.canonical_name,metadata_json=excluded.metadata_json`);
    const metric=db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json) VALUES('presupuesto-abierto',?,?,?,?,?,?,?,'institution',?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,unit=excluded.unit,metadata_json=excluded.metadata_json`);
    const obs=db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json) VALUES('presupuesto-abierto',?,?,?,?,NULL,?,NULL,'organization',?,?,?) ON CONFLICT(source_id,external_id,metric) DO UPDATE SET value_number=excluded.value_number,raw_snapshot_id=excluded.raw_snapshot_id,payload_json=excluded.payload_json`);
    const metrics=[
      {id:"execution_clp",title:"Ejecución presupuestaria",unit:"CLP"},
      {id:"documents",title:"Documentos de ejecución presupuestaria",unit:"N°"},
      {id:"share_pct",title:"Participación en la ejecución presupuestaria",unit:"%"},
    ];
    for(const m of metrics)metric.run(m.id,m.title,"Ejecución publicada por Presupuesto Abierto / DIPRES.","finanzas-publicas","Ejecución institucional",m.unit,"annual",JSON.stringify({mapEligible:false}));
    for(let yi=0;yi<requested.length;yi++){
      const wanted=requested[yi],url=`${BASE}?year=${wanted}&view=list`;
      try{
        console.log(`[presupuesto] ${yi+1}/${requested.length} año solicitado ${wanted}`);const snap=await fetchAndSnapshot("presupuesto-abierto",run,url),actual=selectedYear(snap.text,wanted),trs=tableRows(snap.text);let local=0;
        db.transaction(()=>{for(const cells of trs){const institution=cells[0],service=cells[1],area=cells[2];if(!institution||!service||!area||/instituci[oó]n/i.test(institution))continue;const documents=num(cells[3]),amount=num(cells[4]),share=num(cells[5]);if(documents==null&&amount==null&&share==null)continue;seen++;const external=oid(institution,service,area),name=area===service?service:`${service} — ${area}`;org.run(name,external,JSON.stringify({institution,service,area}));const payload=JSON.stringify({institution,service,area,requestedYear:wanted,publishedYear:actual,sourceUrl:url});if(amount!=null){obs.run(`${external}:execution:${actual}`,String(actual),"execution_clp",amount,"CLP",external,snap.snapshotId,payload);written++;local++}if(documents!=null){obs.run(`${external}:documents:${actual}`,String(actual),"documents",documents,"N°",external,snap.snapshotId,payload);written++;local++}if(share!=null){obs.run(`${external}:share:${actual}`,String(actual),"share_pct",share,"%",external,snap.snapshotId,payload);written++;local++}}})();console.log(`[presupuesto] ✓ publicado=${actual} · filas=${seen} · obs=${local}`)
      }catch(e){failed++;console.error(`[presupuesto] ! ${wanted}: ${String(e)}`)}updateRunProgress(run,seen,written,`${yi+1}/${requested.length} años; failed=${failed}`)
    }
    finishRun(run,written?"success":"failed",`years=${requested.length}; failed=${failed}`,seen,written);if(!written)throw new Error("Presupuesto Abierto no produjo observaciones");return{years:requested.length,seen,written,failed};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
