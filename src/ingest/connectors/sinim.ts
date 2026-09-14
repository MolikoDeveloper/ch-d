import { db, finishRun, startRun } from "../../db";
import { normalizeGeoName, resolveGeoArea } from "../../geo";
import { parseSinimProfile, htmlText } from "../parsers/sinim-profile";
import { fetchAndSnapshot } from "../raw";

const BASE="https://datos.sinim.gov.cl";
const INDEX_URL=`${BASE}/ficha_comunal.php`;

function metricId(section:string,title:string){const h=new Bun.CryptoHasher("sha256");h.update(`${section}:${title}`);return`sinim:${h.digest("hex").slice(0,24)}`}
function seedCommunes(html:string){
  const matches=[...html.matchAll(/>([^<>]{2,90}?)\s*-\s*(\d{5})</g)],unique=new Map<string,string>();
  for(const m of matches){const name=htmlText(m[1]);if(name&&!/seleccione/i.test(name))unique.set(m[2],name)}
  const find=db.prepare(`SELECT id FROM geo_areas WHERE geo_type='commune' AND code=? ORDER BY CASE source_id WHEN 'ide-chile' THEN 0 ELSE 1 END,id LIMIT 1`);
  const ins=db.prepare(`INSERT INTO geo_areas(geo_type,code,name,parent_id,source_id,external_id) VALUES('commune',?,?,?,'sinim',?)`);
  const update=db.prepare(`UPDATE geo_areas SET name=?,parent_id=? WHERE id=?`);
  const alias=db.prepare(`INSERT OR REPLACE INTO geo_aliases(alias,normalized_alias,geo_area_id) VALUES(?,?,?)`);
  for(const[code,name]of unique){const parent=resolveGeoArea(code.slice(0,2),null);const existing=find.get(code)as any;let id:number;if(existing){id=existing.id;update.run(name,parent,id)}else{id=Number(ins.run(code,name,parent,`COM-${code}`).lastInsertRowid)}for(const a of[code,`Comuna de ${name}`])alias.run(a,normalizeGeoName(a),id)}
  return[...unique].map(([code,name])=>({code,name}));
}
function saveAuthorities(code:string,list:ReturnType<typeof parseSinimProfile>["authorities"],snapshotId:number){db.prepare(`DELETE FROM relationships WHERE source_id='sinim' AND from_type='commune' AND from_id=? AND relation_type IN ('mayor','councillor')`).run(code);const person=db.prepare(`INSERT INTO persons(canonical_name,source_id,external_id,metadata_json) VALUES(?,'sinim',?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET canonical_name=excluded.canonical_name,metadata_json=excluded.metadata_json`),rel=db.prepare(`INSERT INTO relationships(source_id,from_type,from_id,relation_type,to_type,to_id,asserted_by,metadata_json) VALUES('sinim','commune',?,?,'person',?,'source',?)`);for(let i=0;i<list.length;i++){const a=list[i],external=`${code}:${a.role}:${i}:${normalizeGeoName(a.name)}`;person.run(a.name,external,JSON.stringify({role:a.role,party:a.party,rawSnapshotId:snapshotId}));rel.run(code,a.role,external,JSON.stringify({party:a.party,rawSnapshotId:snapshotId}))}}

export async function syncSinim(){
  const run=startRun("sinim");let seen=0,written=0,failed=0,authorities=0;
  try{
    console.log("[sinim] Descargando catálogo comunal oficial...");
    const index=await fetchAndSnapshot("sinim",run,INDEX_URL),communes=seedCommunes(index.text);
    console.log(`[sinim] ${communes.length} comunas registradas/resueltas`);
    const limit=Math.min(communes.length,Math.max(1,Number(process.env.SINIM_COMMUNE_LIMIT??communes.length)||communes.length)),selected=communes.slice(0,limit);
    const metric=db.prepare(`INSERT INTO metric_definitions(source_id,external_id,title,description,category,subcategory,unit,frequency,geo_scope,metadata_json) VALUES('sinim',?,?,?,?,?,?,?,'commune',?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,subcategory=excluded.subcategory,unit=excluded.unit,metadata_json=excluded.metadata_json`);
    const obs=db.prepare(`INSERT INTO observations(source_id,external_id,observed_at,metric,value_number,value_text,unit,geo_area_id,subject_type,subject_id,raw_snapshot_id,payload_json) VALUES('sinim',?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,external_id,metric) DO UPDATE SET observed_at=excluded.observed_at,value_number=excluded.value_number,value_text=excluded.value_text,unit=excluded.unit,geo_area_id=excluded.geo_area_id,subject_type=excluded.subject_type,subject_id=excluded.subject_id,raw_snapshot_id=excluded.raw_snapshot_id,payload_json=excluded.payload_json`);
    const setCoords=db.prepare(`UPDATE geo_areas SET centroid_lat=?,centroid_lon=? WHERE id=?`);
    const removeLegacy=db.prepare(`DELETE FROM observations WHERE source_id='sinim' AND geo_area_id=? AND subject_type='commune'`);
    for(let i=0;i<selected.length;i++){
      const{code,name}=selected[i],url=`${INDEX_URL}?municipio=${code}`;
      try{
        const snap=await fetchAndSnapshot("sinim",run,url),parsed=parseSinimProfile(snap.text);seen+=parsed.observations.length;
        const geo=resolveGeoArea(code,null);if(!geo)throw new Error(`comuna ${code} no resuelta`);let local=0;
        db.transaction(()=>{
          if(parsed.coordinates)setCoords.run(parsed.coordinates.lat,parsed.coordinates.lon,geo);
          removeLegacy.run(geo);
          for(const o of parsed.observations){
            const id=metricId(o.section,o.title),periodYear=o.periodYear??parsed.profileYear;
            metric.run(id,o.title,`Ficha comunal SINIM: ${o.section}`,"municipal",o.section,o.unit,"annual",JSON.stringify({source:"SINIM",section:o.section,profile:url}));
            const payload=JSON.stringify({profileYear:parsed.profileYear,periodYear:o.periodYear,periodBasis:o.periodBasis,section:o.section,sourceUrl:url});
            obs.run(`${code}:${id}:${periodYear}`,String(periodYear),id,o.valueNumber,o.valueText,o.unit,geo,"sinim_profile",code,snap.snapshotId,payload);written++;local++;
          }
          saveAuthorities(code,parsed.authorities,snap.snapshotId);authorities+=parsed.authorities.length;
        })();
        console.log(`[sinim] ${i+1}/${selected.length} ✓ ${name} · ficha=${parsed.profileYear} obs=${local} autoridades=${parsed.authorities.length}${parsed.coordinates?' geo=ok':''}`);
      }catch(e){failed++;console.error(`[sinim] ${i+1}/${selected.length} ! ${name}: ${String(e)}`)}
      db.prepare(`UPDATE ingest_runs SET records_seen=?,records_written=?,message=? WHERE id=?`).run(seen,written,`${i+1}/${selected.length} comunas; autoridades=${authorities}; failed=${failed}`,run)
    }
    finishRun(run,"success",`comunas=${selected.length}; autoridades=${authorities}; failed=${failed}`,seen,written);
    return{communes:selected.length,seen,written,authorities,failed};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
