import { db } from "./db";

const REGIONS:Array<[string,string,number,number,string[]]>=[
["15","Arica y Parinacota",-18.48,-70.31,["arica y parinacota"]],["01","Tarapacá",-20.21,-70.15,["tarapaca"]],["02","Antofagasta",-23.65,-70.40,["antofagasta"]],["03","Atacama",-27.37,-70.33,["atacama"]],["04","Coquimbo",-29.95,-71.34,["coquimbo"]],["05","Valparaíso",-33.05,-71.62,["valparaiso"]],["13","Metropolitana de Santiago",-33.45,-70.66,["metropolitana","metropolitana de santiago","santiago"]],["06","O'Higgins",-34.17,-70.74,["ohiggins","o'higgins","libertador general bernardo o'higgins"]],["07","Maule",-35.43,-71.67,["maule"]],["16","Ñuble",-36.61,-72.10,["nuble","ñuble"]],["08","Biobío",-36.82,-73.05,["biobio","biobío"]],["09","La Araucanía",-38.74,-72.59,["araucania","la araucania"]],["14","Los Ríos",-39.81,-73.24,["los rios","los ríos"]],["10","Los Lagos",-41.47,-72.94,["los lagos"]],["11","Aysén",-45.57,-72.07,["aysen","aysén"]],["12","Magallanes y de la Antártica Chilena",-53.16,-70.91,["magallanes","magallanes y antartica chilena","magallanes y de la antartica chilena"]]];

export function normalizeGeoName(v:string){
  return v.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim().replace(/^region\s+(de\s+|del\s+)?/,"").replace(/\s+/g," ");
}
export function seedGeography(){
 db.prepare(`INSERT INTO geo_areas(geo_type,code,name,centroid_lat,centroid_lon,source_id,external_id) VALUES('country','CL','Chile',-33.45,-70.66,'ide-chile','CL') ON CONFLICT(source_id,external_id) DO NOTHING`).run();
 const country=(db.query(`SELECT id FROM geo_areas WHERE source_id='ide-chile' AND external_id='CL'`).get() as any).id;
 const ins=db.prepare(`INSERT INTO geo_areas(geo_type,code,name,parent_id,centroid_lat,centroid_lon,source_id,external_id) VALUES('region',?,?,?,?,?,'ide-chile',?) ON CONFLICT(source_id,external_id) DO UPDATE SET name=excluded.name,centroid_lat=excluded.centroid_lat,centroid_lon=excluded.centroid_lon`);
 const ali=db.prepare(`INSERT OR REPLACE INTO geo_aliases(alias,normalized_alias,geo_area_id) VALUES(?,?,?)`);
 ali.run('Chile','chile',country);
 for(const [code,name,lat,lon,aliases] of REGIONS){ins.run(code,name,country,lat,lon,`REG-${code}`);const id=(db.query(`SELECT id FROM geo_areas WHERE source_id='ide-chile' AND external_id=?`).get(`REG-${code}`) as any).id;for(const a of [name,code,...aliases])ali.run(a,normalizeGeoName(a),id)}
 return {country,regions:REGIONS.length};
}
export function countryGeoAreaId(){seedGeography();return (db.query(`SELECT id FROM geo_areas WHERE source_id='ide-chile' AND external_id='CL'`).get() as any).id}
export function resolveGeoArea(code?:string|null,name?:string|null){if(code){const c=String(code).padStart(2,'0');const r=db.query(`SELECT id FROM geo_areas WHERE code=? OR external_id=? LIMIT 1`).get(c,`REG-${c}`) as any;if(r)return r.id}if(name){const n=normalizeGeoName(name);const r=db.query(`SELECT geo_area_id id FROM geo_aliases WHERE normalized_alias=? LIMIT 1`).get(n) as any;if(r)return r.id;const partial=db.query(`SELECT geo_area_id id FROM geo_aliases WHERE ? LIKE '%'||normalized_alias||'%' ORDER BY length(normalized_alias) DESC LIMIT 1`).get(n) as any;if(partial)return partial.id}return null}

export async function syncOfficialRegions(){
 seedGeography();
 const base=process.env.CHILE_REGIONS_GEOJSON_URL||'https://esri.ciren.cl/server/rest/services/Hosted/REGIONES_COD_INT/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson';
 let res=await fetch(base);if(!res.ok)throw new Error(`Geo HTTP ${res.status}`);let fc=await res.json() as any;
 if(fc.error||!Array.isArray(fc.features)){const fallback=base.replace('f=geojson','f=json');res=await fetch(fallback);if(!res.ok)throw new Error(`Geo HTTP ${res.status}`);fc=await res.json()}
 let updated=0;
 for(const f of fc.features||[]){
   const p=f.properties??f.attributes??{};const code=String(p.COD_REGI??p.COD_REGION??p.CUT_REG??p.REGION_COD??'');const name=String(p.REGION??p.NOM_REG??p.NOMBRE??'');const id=resolveGeoArea(code,name);if(!id||!f.geometry)continue;
   const geometry=f.geometry.type?f.geometry:(Array.isArray(f.geometry.rings)?{type:'Polygon',coordinates:f.geometry.rings}:null);
   if(geometry){db.prepare(`UPDATE geo_areas SET geometry_json=? WHERE id=?`).run(JSON.stringify(geometry),id);updated++}
 }
 return {features:(fc.features||[]).length,updated};
}
