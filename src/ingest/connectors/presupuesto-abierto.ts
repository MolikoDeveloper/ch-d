import { db, finishRun, startRun, updateRunProgress } from "../../db";
import { fetchAndSnapshot } from "../raw";
import { parseJson } from "../parsers/tabular";

type Row=Record<string,unknown>;
const API="https://api.presupuestoabierto.gob.cl/api/v1/data/pagos";

function clean(v:unknown){return String(v??"").replace(/\s+/g," ").trim()}
function norm(v:unknown){return clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim()}
function numeric(v:unknown){if(typeof v==="number")return Number.isFinite(v)?v:null;const raw=clean(v);if(!raw)return null;let s=raw.replace(/[$%\s]/g,"");if(/^[-+]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s))s=s.replace(/\./g,"").replace(",",".");else if(/^[-+]?\d+(?:,\d+)?$/.test(s))s=s.replace(",",".");const n=Number(s);return Number.isFinite(n)?n:null}
function flatten(row:Row){const out:Row={};for(const[k,v]of Object.entries(row)){if(v&&typeof v==="object"&&!Array.isArray(v)&&/^_?id$|group|key/i.test(k))Object.assign(out,v as Row);else out[k]=v}return out}
function field(row:Row,test:(k:string)=>boolean){for(const[k,v]of Object.entries(row))if(test(norm(k)))return v;return null}
function named(row:Row,...names:string[]){const wanted=names.map(norm);for(const[k,v]of Object.entries(row)){const n=norm(k);if(wanted.includes(n))return v}return null}
function amount(row:Row){
  const ranked=Object.entries(row).map(([k,v])=>{const n=norm(k),value=numeric(v);let score=0;if(value==null)return{score:-1,value:null,key:k};if(/monto devengado|devengado/.test(n))score=100;else if(/monto total|total monto|monto/.test(n))score=80;else if(/^total$|suma|sum|valor|value/.test(n))score=60;if(/porcentaje|porc|share|document|cantidad|count|periodo|region/.test(n))score=-1;return{score,value,key:k}}).filter(x=>x.score>=0).sort((a,b)=>b.score-a.score);return ranked[0]??null
}
function documents(row:Row){const v=field(row,k=>/numero.*document|n.*document|documentos|cantidad.*document|^count$|recuento/.test(k));return numeric(v)}
function oid(institution:string,service:string,area:string){const h=new Bun.CryptoHasher("sha256");h.update(`${institution}|${service}|${area}`);return`pa:${h.digest("hex").slice(0,24)}`}
function queryUrl(year:number){const groupBy=encodeURIComponent(JSON.stringify(["partida","capitulo","area"])),where=encodeURIComponent(JSON.stringify({periodo:year}));return`${API}?group-by=${groupBy}&where=${where}`}
function institutionParts(row:Row){
  const institution=clean(named(row,"partida","institucion","institución","nombre partida"));
  const service=clean(named(row,"capitulo","capítulo","servicio","nombre capitulo","nombre capítulo"));
  const area=clean(named(row,"area","área","nombre area","nombre área"));
  return{institution,service,area};
}

export async function syncPresupuestoAbierto(){
  const run=startRun("presupuesto-abierto");let seen=0,written=0,failed=0;
  try{
    const requested=(process.env.PRESUPUESTO_ABIERTO_YEARS??String(new Date().getFullYear())).split(",").map(x=>Number(x.trim())).filter(y=>y>=2016&&y<=2100);
    const org=db.prepare(`INSERT INTO organizations(canonical_name,organization_type,source_id,external_id,metadata_json) VALUES(?,'public_body','presupuesto-abierto',?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET canonical_name=excluded.canonical_name,metadata_json=excluded.metadata_json`);
    const metric=db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json) VALUES('presupuesto-abierto',?,?,?,?,?,?,?,'institution',?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,description=excluded.description,unit=excluded.unit,metadata_json=excluded.metadata_json`);
    const obs=db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json) VALUES('presupuesto-abierto',?,?,?,?,NULL,?,NULL,'organization',?,?,?) ON CONFLICT(source_id,external_id,metric) DO UPDATE SET observed_at=excluded.observed_at,value_number=excluded.value_number,unit=excluded.unit,subject_id=excluded.subject_id,raw_snapshot_id=excluded.raw_snapshot_id,payload_json=excluded.payload_json`);
    for(const m of[
      {id:"execution_clp",title:"Ejecución presupuestaria",unit:"CLP"},
      {id:"documents",title:"Documentos de ejecución presupuestaria",unit:"N°"},
      {id:"share_pct",title:"Participación en la ejecución presupuestaria",unit:"%"},
    ])metric.run(m.id,m.title,"Ejecución agregada publicada por Presupuesto Abierto / DIPRES.","finanzas-publicas","Ejecución institucional",m.unit,"annual",JSON.stringify({mapEligible:false,api:API}));

    for(let yi=0;yi<requested.length;yi++){
      const year=requested[yi],url=queryUrl(year);
      try{
        console.log(`[presupuesto] ${yi+1}/${requested.length} año ${year} · consultando API agregada...`);
        const snap=await fetchAndSnapshot("presupuesto-abierto",run,url),parsed=parseJson(snap.text).map(flatten);console.log(`[presupuesto] ${year} · filas API=${parsed.length}`);
        const prepared:Array<{institution:string;service:string;area:string;external:string;amount:number;documents:number|null;row:Row}>=[];
        for(const row of parsed){seen++;const p=institutionParts(row),a=amount(row);if(!p.institution||!p.service||!p.area||a?.value==null)continue;prepared.push({...p,external:oid(p.institution,p.service,p.area),amount:a.value,documents:documents(row),row})}
        if(!prepared.length){const sample=parsed[0]??{};throw new Error(`API respondió ${parsed.length} filas pero ninguna normalizable; claves=${Object.keys(sample).join(",")}`)}
        const total=prepared.reduce((a,r)=>a+r.amount,0);let local=0;
        db.transaction(()=>{for(const r of prepared){const name=r.area===r.service?r.service:`${r.service} — ${r.area}`,payload=JSON.stringify({institution:r.institution,service:r.service,area:r.area,year,sourceUrl:url});org.run(name,r.external,JSON.stringify({institution:r.institution,service:r.service,area:r.area}));obs.run(`${r.external}:execution:${year}`,String(year),"execution_clp",r.amount,"CLP",r.external,snap.snapshotId,payload);written++;local++;if(r.documents!=null){obs.run(`${r.external}:documents:${year}`,String(year),"documents",r.documents,"N°",r.external,snap.snapshotId,payload);written++;local++}if(total>0){obs.run(`${r.external}:share:${year}`,String(year),"share_pct",r.amount/total*100,"%",r.external,snap.snapshotId,payload);written++;local++}}})();
        console.log(`[presupuesto] ✓ ${year} · áreas=${prepared.length} · obs=${local} · total=${Math.round(total).toLocaleString("es-CL")} CLP`);
      }catch(e){failed++;console.error(`[presupuesto] ! ${year}: ${String(e)}`)}updateRunProgress(run,seen,written,`${yi+1}/${requested.length} años; obs=${written}; failed=${failed}`)
    }
    finishRun(run,written?"success":"failed",`years=${requested.length}; observations=${written}; failed=${failed}`,seen,written);if(!written)throw new Error("Presupuesto Abierto no produjo observaciones desde la API agrupada");return{years:requested.length,seen,written,failed};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
