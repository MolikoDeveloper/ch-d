import Papa from "papaparse";
import { db, finishRun, startRun } from "../../db";
import { resolveGeoArea } from "../../geo";
import { fetchAndSnapshot } from "../raw";

const BASE="https://sdmx.ine.gob.cl/rest";
type Flow={id:string;version:string;agency:string;title:string};

function attr(attrs:string,name:string){return new RegExp(`${name}="([^"]+)"`).exec(attrs)?.[1]??""}
function strip(v:string){return v.replace(/<[^>]+>/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g," ").trim()}
function discoverFlows(xml:string):Flow[]{const out:Flow[]=[];for(const m of xml.matchAll(/<(?:\w+:)?Dataflow\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Dataflow>/g)){const a=m[1],body=m[2],id=attr(a,"id");if(!id)continue;const names=[...body.matchAll(/<(?:\w+:)?Name\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Name>/g)];const es=names.find(n=>/(?:xml:)?lang="es"/i.test(n[1]));const title=strip((es??names[0])?.[2]??id);out.push({id,version:attr(a,"version")||"latest",agency:attr(a,"agencyID")||"CL01",title})}return out}
function parsePeriod(v:unknown){const s=String(v??"");if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);if(/^\d{4}-\d{2}$/.test(s))return`${s}-01`;if(/^\d{4}-Q[1-4]$/i.test(s)){const q=Number(s.at(-1));return`${s.slice(0,4)}-${String((q-1)*3+1).padStart(2,"0")}-01`}if(/^\d{4}$/.test(s))return`${s}-01-01`;return null}
function num(v:unknown){if(v==null||v==='')return null;const n=Number(String(v).replace(",","."));return Number.isFinite(n)?n:null}
function findKey(row:Record<string,unknown>,re:RegExp){return Object.keys(row).find(k=>re.test(k))}
function hash(v:string){const h=new Bun.CryptoHasher("sha256");h.update(v);return h.digest("hex").slice(0,20)}

function chooseFlows(flows:Flow[]){const explicit=(process.env.INE_FLOWS??"").split(',').map(x=>x.trim()).filter(Boolean);if(explicit.length)return flows.filter(f=>explicit.includes(f.id));const re=/(desocup|ocupaci|informal|remuner|accident|empleo|fuerza de trabajo|tasa de particip)/i;return flows.filter(f=>re.test(f.title)).slice(0,Number(process.env.INE_FLOW_LIMIT??6))}

export async function syncIne(){
  const run=startRun("ine");let seen=0,written=0,failed=0;
  try{
    console.log("[ine] Descubriendo dataflows SDMX...");
    const catalog=await fetchAndSnapshot("ine",run,`${BASE}/dataflow/CL01/all/latest`);
    const flows=discoverFlows(catalog.text);console.log(`[ine] ${flows.length} dataflows encontrados`);
    const catalogStmt=db.prepare(`INSERT INTO source_catalog_items(source_id,external_id,title,description,publisher,page_url,metadata_json,updated_at) VALUES('ine',?,?,NULL,'Instituto Nacional de Estadísticas',?, ?,NULL) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,metadata_json=excluded.metadata_json`);
    for(const f of flows)catalogStmt.run(f.id,f.title,`https://sdmx.ine.gob.cl/`,JSON.stringify(f));
    const selected=chooseFlows(flows);console.log(`[ine] ${selected.length} dataflows seleccionados para descarga`);
    for(let i=0;i<selected.length;i++){
      const f=selected[i],url=`${BASE}/data/${f.agency},${f.id},${f.version}?format=csv`;
      console.log(`[ine] ${i+1}/${selected.length} ${f.id} · ${f.title}`);
      try{
        const snap=await fetchAndSnapshot("ine",run,url,{headers:{accept:"text/csv"}});
        const parsed=Papa.parse<Record<string,unknown>>(snap.text,{header:true,skipEmptyLines:true,dynamicTyping:false});
        const rows=parsed.data;seen+=rows.length;
        const metricStmt=db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json) VALUES('ine',?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,unit=excluded.unit,frequency=excluded.frequency,geo_scope=excluded.geo_scope,metadata_json=excluded.metadata_json`);
        const obsStmt=db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json) VALUES('ine',?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(source_id,external_id,metric) DO UPDATE SET observed_at=excluded.observed_at,value_number=excluded.value_number,value_text=excluded.value_text,unit=excluded.unit,geo_area_id=excluded.geo_area_id,raw_snapshot_id=excluded.raw_snapshot_id`);
        let local=0;
        db.transaction(()=>{
          for(const row of rows){
            const valueKey=findKey(row,/^OBS_VALUE$/i)??findKey(row,/VALUE/i);if(!valueKey)continue;const value=num(row[valueKey]);if(value==null)continue;
            const timeKey=findKey(row,/^(TIME_PERIOD|TIME)$/i);const observed=parsePeriod(timeKey?row[timeKey]:null);
            const geoKey=findKey(row,/^(REF_AREA|REGION|REGION_CODE|COD_REGION|TERRITORIO|AREA)$/i);const geoRaw=geoKey?String(row[geoKey]??''):'';const geo=geoRaw?resolveGeoArea(geoRaw,geoRaw):null;
            const unitKey=findKey(row,/^(UNIT_MEASURE|UNIT|UNIDAD)$/i);const freqKey=findKey(row,/^FREQ$/i);
            const ignored=new Set([valueKey,timeKey,geoKey,unitKey,freqKey].filter(Boolean) as string[]);for(const k of Object.keys(row))if(/^(OBS_STATUS|DECIMALS|UNIT_MULT|BASE_PER|COMMENT|NOTE)$/i.test(k))ignored.add(k);
            const dims=Object.entries(row).filter(([k,v])=>!ignored.has(k)&&v!=null&&String(v)!=='').sort(([a],[b])=>a.localeCompare(b));const signature=dims.map(([k,v])=>`${k}=${v}`).join('|');const metric=`ine:${f.id}:${hash(signature||'all')}`;const title=signature?`${f.title} · ${dims.slice(0,4).map(([k,v])=>`${k} ${v}`).join(' · ')}`:f.title;const scope=geo?((db.query(`SELECT geo_type FROM geo_areas WHERE id=?`).get(geo)as any)?.geo_type??'region'):'country';metricStmt.run(metric,title,f.title,"estadisticas","mercado-laboral",unitKey?String(row[unitKey]??''):null,freqKey?String(row[freqKey]??''):null,scope,JSON.stringify({flow:f,dimensions:Object.fromEntries(dims)}));const ext=`${f.id}:${hash(`${signature}|${geoRaw}|${observed??''}`)}`;obsStmt.run(ext,observed,metric,value,null,unitKey?String(row[unitKey]??''):null,geo,"statistical_series",f.id,snap.snapshotId);written++;local++
          }
        })();
        console.log(`[ine] ${i+1}/${selected.length} ✓ filas=${rows.length} observaciones=${local}`);
      }catch(e){failed++;console.error(`[ine] ${i+1}/${selected.length} ! ${String(e)}`)}
      db.prepare(`UPDATE ingest_runs SET records_seen=?,records_written=?,message=? WHERE id=?`).run(seen,written,`${i+1}/${selected.length} dataflows; failed=${failed}`,run);
    }
    finishRun(run,"success",`dataflows=${selected.length}; failed=${failed}`,seen,written);return{catalog:flows.length,dataflows:selected.length,seen,written,failed};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
