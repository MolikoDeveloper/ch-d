import { db, finishRun, startRun } from "../../db";
import { normalizeGeoName, resolveGeoArea } from "../../geo";
import { fetchAndSnapshot } from "../raw";

const BASE="https://datos.sinim.gov.cl";
const INDEX_URL=`${BASE}/ficha_comunal.php`;

function decodeHtml(s:string){return s.replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&deg;/gi,"°").replace(/&sup2;/gi,"²").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)))}
function text(html:string){return decodeHtml(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim())}
function numeric(v:string){const s=v.trim().replace(/\s/g,"").replace(/\.(?=\d{3}(?:\D|$))/g,"").replace(",",".").replace(/%$/,"");if(!s||/^(?:n\/?a|s\/?d|sin dato|sin dato oficial|no aplica|no recepcionado|descontinuado|-+)$/i.test(s))return null;const n=Number(s);return Number.isFinite(n)?n:null}
function metricId(section:string,title:string){const h=new Bun.CryptoHasher("sha256");h.update(`${section}:${title}`);return`sinim:${h.digest("hex").slice(0,24)}`}

function seedCommunes(html:string){
  const matches=[...html.matchAll(/>([^<>]{2,90}?)\s*-\s*(\d{5})</g)];
  const unique=new Map<string,string>();
  for(const m of matches){const name=text(m[1]);if(name&&!/seleccione/i.test(name))unique.set(m[2],name)}
  const ins=db.prepare(`INSERT INTO geo_areas(geo_type,code,name,parent_id,source_id,external_id) VALUES('commune',?,?,?,'sinim',?) ON CONFLICT(source_id,external_id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id`);
  const alias=db.prepare(`INSERT OR IGNORE INTO geo_aliases(alias,normalized_alias,geo_area_id) VALUES(?,?,?)`);
  let written=0;
  for(const[code,name]of unique){
    const parent=resolveGeoArea(code.slice(0,2),null);ins.run(code,name,parent,`COM-${code}`);
    const g=db.query(`SELECT id FROM geo_areas WHERE source_id='sinim' AND external_id=?`).get(`COM-${code}`)as{id:number};
    for(const a of[code,`Comuna de ${name}`]) alias.run(a,normalizeGeoName(a),g.id);
    written++;
  }
  return [...unique].map(([code,name])=>({code,name}));
}

function parseProfile(html:string){
  const year=Number(html.match(/año\s+(20\d{2})/i)?.[1]??new Date().getFullYear());
  const headings:Array<{at:number,name:string}>=[];
  for(const m of html.matchAll(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/gi)) headings.push({at:m.index??0,name:text(m[1])});
  const observations:Array<{section:string,title:string,unit:string|null,valueNumber:number|null,valueText:string|null}>=[];
  for(const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)){
    const at=table.index??0;let section="Ficha comunal";
    for(const h of headings){if(h.at>at)break;if(h.name)section=h.name}
    for(const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
      const cells=[...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c=>text(c[1]));
      if(cells.length<3)continue;
      const title=cells[0]?.trim(),unit=cells[1]?.trim()||null,value=cells[2]?.trim();
      if(!title||!value||/^(informaci[oó]n|dato|descripci[oó]n)$/i.test(title)||/^(comunal|municipal)$/i.test(value))continue;
      const n=numeric(value);const valueText=n==null?value:null;
      if(n==null&&!valueText)continue;
      observations.push({section,title,unit,valueNumber:n,valueText});
    }
  }
  return{year,observations};
}

export async function syncSinim(){
  const run=startRun("sinim");let seen=0,written=0,failed=0;
  try{
    console.log("[sinim] Descargando catálogo comunal oficial...");
    const index=await fetchAndSnapshot("sinim",run,INDEX_URL);
    const communes=seedCommunes(index.text);
    console.log(`[sinim] ${communes.length} comunas registradas/resueltas`);
    const limit=Math.min(communes.length,Math.max(1,Number(process.env.SINIM_COMMUNE_LIMIT??communes.length)||communes.length));
    const selected=communes.slice(0,limit);
    const metricStmt=db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json) VALUES('sinim',?,?,?,?,?,?,?,'commune',?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,subcategory=excluded.subcategory,unit=excluded.unit,metadata_json=excluded.metadata_json`);
    const obsStmt=db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json) VALUES('sinim',?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(source_id,external_id,metric) DO UPDATE SET observed_at=excluded.observed_at,value_number=excluded.value_number,value_text=excluded.value_text,unit=excluded.unit,geo_area_id=excluded.geo_area_id,raw_snapshot_id=excluded.raw_snapshot_id`);
    for(let i=0;i<selected.length;i++){
      const {code,name}=selected[i];const url=`${INDEX_URL}?municipio=${code}`;
      try{
        const snap=await fetchAndSnapshot("sinim",run,url);const parsed=parseProfile(snap.text);seen+=parsed.observations.length;
        const geo=resolveGeoArea(code,null);if(!geo)throw new Error(`comuna ${code} no resuelta`);
        let localWritten=0;
        db.transaction(()=>{for(const o of parsed.observations){const metric=metricId(o.section,o.title);metricStmt.run(metric,o.title,`Ficha comunal SINIM: ${o.section}`,"municipal",o.section,o.unit,"annual",JSON.stringify({source:"SINIM",section:o.section,profile:url,year:parsed.year}));const ext=`${code}:${metric}:${parsed.year}`;obsStmt.run(ext,`${parsed.year}-12-31`,metric,o.valueNumber,o.valueText,o.unit,geo,"commune",code,snap.snapshotId);written++;localWritten++}})();
        console.log(`[sinim] ${i+1}/${selected.length} ✓ ${name} · obs=${localWritten}`);
      }catch(e){failed++;console.error(`[sinim] ${i+1}/${selected.length} ! ${name}: ${String(e)}`)}
      db.prepare(`UPDATE ingest_runs SET records_seen=?,records_written=?,message=? WHERE id=?`).run(seen,written,`${i+1}/${selected.length} comunas; failed=${failed}`,run);
    }
    finishRun(run,"success",`comunas=${selected.length}; failed=${failed}`,seen,written);return{communes:selected.length,seen,written,failed};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
