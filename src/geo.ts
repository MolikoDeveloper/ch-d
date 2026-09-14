import { db } from "./db";

const REGIONS:Array<[string,string,number,number,string[]]>=[
["15","Arica y Parinacota",-18.48,-70.31,["arica y parinacota"]],["01","Tarapacá",-20.21,-70.15,["tarapaca"]],["02","Antofagasta",-23.65,-70.40,["antofagasta"]],["03","Atacama",-27.37,-70.33,["atacama"]],["04","Coquimbo",-29.95,-71.34,["coquimbo"]],["05","Valparaíso",-33.05,-71.62,["valparaiso"]],["13","Metropolitana de Santiago",-33.45,-70.66,["metropolitana","metropolitana de santiago","santiago"]],["06","O'Higgins",-34.17,-70.74,["ohiggins","o'higgins","libertador general bernardo o'higgins"]],["07","Maule",-35.43,-71.67,["maule"]],["16","Ñuble",-36.61,-72.10,["nuble","ñuble"]],["08","Biobío",-36.82,-73.05,["biobio","biobío"]],["09","La Araucanía",-38.74,-72.59,["araucania","la araucania"]],["14","Los Ríos",-39.81,-73.24,["los rios","los ríos"]],["10","Los Lagos",-41.47,-72.94,["los lagos"]],["11","Aysén",-45.57,-72.07,["aysen","aysén"]],["12","Magallanes y de la Antártica Chilena",-53.16,-70.91,["magallanes","magallanes y antartica chilena","magallanes y de la antartica chilena"]]];

export function normalizeGeoName(v:string){return v.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim().replace(/^region\s+(de\s+|del\s+)?/,"").replace(/\s+/g," ")}

export function seedGeography(){
  db.prepare(`INSERT INTO geo_areas(geo_type,code,name,centroid_lat,centroid_lon,source_id,external_id) VALUES('country','CL','Chile',-33.45,-70.66,'ide-chile','CL') ON CONFLICT(source_id,external_id) DO NOTHING`).run();
  const country=(db.query(`SELECT id FROM geo_areas WHERE source_id='ide-chile' AND external_id='CL'`).get() as any).id;
  const ins=db.prepare(`INSERT INTO geo_areas(geo_type,code,name,parent_id,centroid_lat,centroid_lon,source_id,external_id) VALUES('region',?,?,?,?,?,'ide-chile',?) ON CONFLICT(source_id,external_id) DO UPDATE SET name=excluded.name,centroid_lat=excluded.centroid_lat,centroid_lon=excluded.centroid_lon`);
  const ali=db.prepare(`INSERT OR REPLACE INTO geo_aliases(alias,normalized_alias,geo_area_id) VALUES(?,?,?)`);
  ali.run('Chile','chile',country);
  for(const[code,name,lat,lon,aliases]of REGIONS){
    ins.run(code,name,country,lat,lon,`REG-${code}`);
    const id=(db.query(`SELECT id FROM geo_areas WHERE source_id='ide-chile' AND external_id=?`).get(`REG-${code}`)as any).id;
    for(const a of[name,code,...aliases])ali.run(a,normalizeGeoName(a),id);
  }
  return{country,regions:REGIONS.length};
}

export function countryGeoAreaId(){seedGeography();return(db.query(`SELECT id FROM geo_areas WHERE source_id='ide-chile' AND external_id='CL'`).get()as any).id}

export function resolveGeoArea(code?:string|null,name?:string|null){
  if(code){let c=String(code).trim().replace(/\.0+$/,"");if(/^\d+$/.test(c)){if(c.length<=2)c=c.padStart(2,'0');else if(c.length<5)c=c.padStart(5,'0')}const r=db.query(`SELECT id FROM geo_areas WHERE code=? OR external_id=? OR external_id=? LIMIT 1`).get(c,`REG-${c}`,`COM-${c}`)as any;if(r)return r.id}
  if(name){const n=normalizeGeoName(name);const r=db.query(`SELECT geo_area_id id FROM geo_aliases WHERE normalized_alias=? LIMIT 1`).get(n)as any;if(r)return r.id;const partial=db.query(`SELECT geo_area_id id FROM geo_aliases WHERE ? LIKE '%'||normalized_alias||'%' ORDER BY length(normalized_alias) DESC LIMIT 1`).get(n)as any;if(partial)return partial.id}
  return null;
}

function humanBytes(n:number){if(n<1024)return`${n} B`;if(n<1024*1024)return`${(n/1024).toFixed(1)} KiB`;return`${(n/1024/1024).toFixed(1)} MiB`}
function esriGeometry(g:any){if(g?.type)return g;if(Array.isArray(g?.rings))return{type:'Polygon',coordinates:g.rings};return null}
async function fetchFeatures(url:string,label:string,timeout:number){
  console.log(`[geo] Descargando ${label}...`);
  let res=await fetch(url,{signal:AbortSignal.timeout(timeout)});console.log(`[geo] ${label}: HTTP ${res.status}`);if(!res.ok)throw new Error(`${label} HTTP ${res.status}`);
  let text=await res.text();console.log(`[geo] ${label}: ${humanBytes(Buffer.byteLength(text))}`);let fc=JSON.parse(text)as any;
  if(fc.error||!Array.isArray(fc.features)){
    const fallback=url.replace('f=geojson','f=json');res=await fetch(fallback,{signal:AbortSignal.timeout(timeout)});if(!res.ok)throw new Error(`${label} HTTP ${res.status}`);text=await res.text();fc=JSON.parse(text);
  }
  return fc.features||[];
}

export async function syncOfficialRegions(){
  const started=performance.now(),timeout=Number(process.env.GEO_SYNC_TIMEOUT_MS??60000);seedGeography();
  const regionsUrl=process.env.CHILE_REGIONS_GEOJSON_URL||'https://esri.ciren.cl/server/rest/services/Hosted/REGIONES_COD_INT/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&returnGeometry=true&f=geojson';
  const communesUrl=process.env.CHILE_COMMUNES_GEOJSON_URL||'https://esri.ciren.cl/server/rest/services/LIMITES_ADMINISTRATIVOS/FeatureServer/3/query?where=1%3D1&outFields=codreg%2Ccodpro%2Ccodcom%2Cnomreg%2Cnompro%2Cnomcom&outSR=4326&returnGeometry=true&f=geojson';

  const regionFeatures=await fetchFeatures(regionsUrl,'regiones',timeout);let regionsUpdated=0,regionsSkipped=0;
  const updateRegion=db.prepare(`UPDATE geo_areas SET geometry_json=? WHERE id=?`);
  for(const f of regionFeatures){const p=f.properties??f.attributes??{},code=String(p.COD_REGI??p.COD_REGION??p.CUT_REG??p.REGION_COD??p.codreg??''),name=String(p.REGION??p.NOM_REG??p.NOMBRE??p.nomreg??''),id=resolveGeoArea(code,name),geometry=esriGeometry(f.geometry);if(id&&geometry){updateRegion.run(JSON.stringify(geometry),id);regionsUpdated++}else regionsSkipped++}
  console.log(`[geo] Regiones: ${regionsUpdated}/${regionFeatures.length} guardadas`);

  const communeFeatures=await fetchFeatures(communesUrl,'comunas',timeout);let communesUpdated=0,communesSkipped=0;
  const findExisting=db.prepare(`SELECT id FROM geo_areas WHERE geo_type='commune' AND code=? ORDER BY CASE source_id WHEN 'ide-chile' THEN 0 ELSE 1 END,id LIMIT 1`);
  const insertCommune=db.prepare(`INSERT INTO geo_areas(geo_type,code,name,parent_id,source_id,external_id,geometry_json) VALUES('commune',?,?,?,'ide-chile',?,?)`);
  const promote=db.prepare(`UPDATE geo_areas SET name=?,parent_id=?,source_id='ide-chile',external_id=?,geometry_json=? WHERE id=?`);
  const alias=db.prepare(`INSERT OR REPLACE INTO geo_aliases(alias,normalized_alias,geo_area_id) VALUES(?,?,?)`);
  for(let i=0;i<communeFeatures.length;i++){
    const f=communeFeatures[i],p=f.properties??f.attributes??{},code=String(p.codcom??p.CODCOM??p.COD_COM??'').padStart(5,'0'),name=String(p.nomcom??p.NOMCOM??p.NOM_COM??''),regionCode=String(p.codreg??p.CODREG??p.COD_REG??'').padStart(2,'0'),geometry=esriGeometry(f.geometry),parent=resolveGeoArea(regionCode,null);
    if(!/^\d{5}$/.test(code)||!name||!geometry||!parent){communesSkipped++;continue}
    const existing=findExisting.get(code)as any;let id:number;
    if(existing){id=existing.id;try{promote.run(name,parent,`COM-${code}`,JSON.stringify(geometry),id)}catch{db.prepare(`UPDATE geo_areas SET name=?,parent_id=?,geometry_json=? WHERE id=?`).run(name,parent,JSON.stringify(geometry),id)}}
    else{id=Number(insertCommune.run(code,name,parent,`COM-${code}`,JSON.stringify(geometry)).lastInsertRowid)}
    alias.run(code,normalizeGeoName(code),id);alias.run(`Comuna de ${name}`,normalizeGeoName(`Comuna de ${name}`),id);communesUpdated++;
    if((i+1)%50===0||i+1===communeFeatures.length)console.log(`[geo] Comunas: ${i+1}/${communeFeatures.length} · guardadas=${communesUpdated}`);
  }

  const seconds=((performance.now()-started)/1000).toFixed(1);console.log(`[geo] Listo en ${seconds}s · regiones=${regionsUpdated} comunas=${communesUpdated}`);
  return{regions:{features:regionFeatures.length,updated:regionsUpdated,skipped:regionsSkipped},communes:{features:communeFeatures.length,updated:communesUpdated,skipped:communesSkipped},seconds:Number(seconds)};
}
