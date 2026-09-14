import { db } from "../db";

const rows=(q:string,...p:any[])=>db.query(q).all(...p) as any[];
const one=(q:string,...p:any[])=>db.query(q).get(...p) as any|null;

const SOURCE_NAMES:Record<string,string>={
  sinim:"SINIM / SUBDERE",
  ine:"Instituto Nacional de Estadísticas (INE)",
  "energia-abierta":"Comisión Nacional de Energía (CNE)",
  bcentral:"Banco Central de Chile",
  chilecompra:"ChileCompra / Mercado Público",
};

function sinimPeriodLabel(row:any){
  if(!row?.payload_json)return row?.observed_at??null;
  try{
    const p=JSON.parse(row.payload_json);
    if(p.periodBasis==="section"&&p.periodYear)return String(p.periodYear);
    if(p.profileYear)return `Ficha ${p.profileYear}`;
  }catch{}
  return row.observed_at??null;
}

function authorityPosition(role:string){return role==="mayor"?"Alcalde/Alcaldesa":role==="councillor"?"Concejal/Concejala":role}

export function territoriesPayload(){
  const regions=rows(`SELECT id,code,name,centroid_lat,centroid_lon FROM geo_areas WHERE source_id='ide-chile' AND geo_type='region' ORDER BY CAST(code AS INTEGER),name`);
  const communes=rows(`
    WITH counts AS (SELECT geo_area_id,COUNT(*) indicator_rows FROM observations WHERE source_id='sinim' AND geo_area_id IS NOT NULL GROUP BY geo_area_id)
    SELECT c.id,c.code,c.name,c.parent_id region_id,r.code region_code,r.name region_name,c.centroid_lat,c.centroid_lon,COALESCE(x.indicator_rows,0) indicator_rows
    FROM geo_areas c LEFT JOIN geo_areas r ON r.id=c.parent_id LEFT JOIN counts x ON x.geo_area_id=c.id
    WHERE c.geo_type='commune' ORDER BY r.name,c.name
  `);
  return{regions,communes};
}

export function indicatorCatalog(sourceId:string){
  if(!["sinim","ine","energia-abierta","bcentral"].includes(sourceId))return[];
  return rows(`SELECT external_id metric,title,subcategory,unit,frequency,geo_scope FROM metric_definitions WHERE source_id=? AND geo_scope IN ('region','commune') ORDER BY COALESCE(subcategory,''),title`,sourceId);
}

export function communeProfile(code:string){
  const commune=one(`
    SELECT c.id,c.code,c.name,c.centroid_lat,c.centroid_lon,c.geometry_json,r.id region_id,r.code region_code,r.name region_name
    FROM geo_areas c LEFT JOIN geo_areas r ON r.id=c.parent_id
    WHERE c.geo_type='commune' AND c.code=? ORDER BY CASE c.source_id WHEN 'ide-chile' THEN 0 ELSE 1 END,c.id LIMIT 1
  `,code);
  if(!commune)return null;
  const indicators=rows(`
    WITH ranked AS (
      SELECT m.external_id metric,m.title,m.subcategory,m.unit,m.frequency,o.observed_at,o.value_number,o.value_text,o.payload_json,
             ROW_NUMBER() OVER(PARTITION BY o.metric ORDER BY o.observed_at DESC,o.id DESC) rn
      FROM observations o JOIN metric_definitions m ON m.source_id=o.source_id AND m.external_id=o.metric
      WHERE o.source_id='sinim' AND o.geo_area_id=?
    )
    SELECT metric,title,subcategory,unit,frequency,observed_at,value_number,value_text,payload_json FROM ranked WHERE rn=1
    ORDER BY COALESCE(subcategory,''),title
  `,commune.id).map(x=>({...x,observed_at:sinimPeriodLabel(x),payload_json:undefined}));
  const authorities=rows(`
    SELECT r.relation_type role,p.canonical_name name,json_extract(r.metadata_json,'$.party') party
    FROM relationships r JOIN persons p ON p.source_id='sinim' AND p.external_id=r.to_id
    WHERE r.source_id='sinim' AND r.from_type='commune' AND r.from_id=? AND r.relation_type IN ('mayor','councillor')
    ORDER BY CASE r.relation_type WHEN 'mayor' THEN 0 ELSE 1 END,p.canonical_name
  `,code).map(row=>({
    role:row.role,
    position:authorityPosition(row.role),
    name:row.name,
    party:row.party||null,
    source:SOURCE_NAMES.sinim,
  }));
  const periods=[...new Set(indicators.map(x=>x.observed_at).filter(Boolean))];
  return{commune,source:SOURCE_NAMES.sinim,periods,authorities,indicators};
}

export function indicatorMap(sourceId:string,metricId:string){
  if(!["sinim","ine","energia-abierta","bcentral"].includes(sourceId))return null;
  const metric=one(`SELECT external_id metric,title,subcategory,unit,frequency,geo_scope FROM metric_definitions WHERE source_id=? AND external_id=?`,sourceId,metricId);if(!metric)return null;
  let values=rows(`
    WITH ranked AS (
      SELECT o.geo_area_id,o.observed_at,o.value_number,o.value_text,o.payload_json,ROW_NUMBER() OVER(PARTITION BY o.geo_area_id ORDER BY o.observed_at DESC,o.id DESC) rn
      FROM observations o WHERE o.source_id=? AND o.metric=? AND o.geo_area_id IS NOT NULL
    )
    SELECT g.id geo_id,g.geo_type,g.code,g.name,g.parent_id,g.centroid_lat,g.centroid_lon,g.geometry_json,p.code region_code,p.name region_name,
           r.observed_at,r.value_number,r.value_text,r.payload_json
    FROM ranked r JOIN geo_areas g ON g.id=r.geo_area_id LEFT JOIN geo_areas p ON p.id=g.parent_id WHERE r.rn=1 ORDER BY g.name
  `,sourceId,metricId);
  if(sourceId==='sinim')values=values.map(v=>({...v,observed_at:sinimPeriodLabel(v),payload_json:undefined}));else values=values.map(v=>({...v,payload_json:undefined}));
  const numeric=values.map(v=>Number(v.value_number)).filter(Number.isFinite);
  return{sourceId,source:SOURCE_NAMES[sourceId]??sourceId,metric,min:numeric.length?Math.min(...numeric):null,max:numeric.length?Math.max(...numeric):null,values};
}

export function searchPublicData(q:string,limit=50){
  const term=`%${q.trim()}%`;if(!q.trim())return{communes:[],metrics:[]};
  const communes=rows(`SELECT c.code,c.name,r.name region_name,c.centroid_lat,c.centroid_lon FROM geo_areas c LEFT JOIN geo_areas r ON r.id=c.parent_id WHERE c.geo_type='commune' AND c.name LIKE ? ORDER BY c.name LIMIT ?`,term,limit);
  const metrics=rows(`SELECT source_id,external_id metric,title,subcategory,unit,geo_scope FROM metric_definitions WHERE title LIKE ? ORDER BY title LIMIT ?`,term,limit);
  return{communes,metrics};
}
