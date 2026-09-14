import { db, finishRun, startRun } from "../../db";
import { resolveGeoArea } from "../../geo";
import { fetchAndSnapshot } from "../raw";

const HISTORY="https://www.gob.cl/patrimoniolamoneda/";
const MONUMENT="https://www.monumentos.gob.cl/monumentos/monumentos-historicos/palacio-de-la-moneda-antigua-real-casa-de-moneda";

function ensureSource(){db.prepare(`INSERT INTO sources(id,name,institution,domain,base_url,auth_kind,automatic,metadata_json) VALUES('presidencia','Presidencia de la República','Presidencia de la República de Chile','instituciones','https://www.presidencia.cl','none',1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,institution=excluded.institution,domain=excluded.domain,base_url=excluded.base_url,automatic=1,metadata_json=excluded.metadata_json`).run(JSON.stringify({territorialLevels:["nacional","comuna","lugar"],description:"Sede de Gobierno, patrimonio presidencial y lugares institucionales."}))}

export async function syncPresidencia(){
  ensureSource();const run=startRun("presidencia");let seen=0,written=0;
  try{
    const [history,monument]=await Promise.all([fetchAndSnapshot("presidencia",run,HISTORY),fetchAndSnapshot("presidencia",run,MONUMENT)]);seen=2;
    const santiago=resolveGeoArea("13101",null);if(!santiago)throw new Error("No se pudo resolver comuna de Santiago (13101)");
    const evidence=`${history.text} ${monument.text}`;
    if(!/Palacio de (?:La|la) Moneda/i.test(evidence))throw new Error("Las fuentes oficiales ya no contienen la ficha esperada de Palacio de La Moneda");
    const metadata={architect:"Joaquín Toesca",originalUse:"Real Casa de Moneda de Santiago",inauguratedYear:1805,governmentSeatSince:1846,heritageStatus:"Monumento Histórico",heritageDecree:"Decreto Nº 5058 (1951)",historySource:HISTORY,heritageSource:MONUMENT};
    db.prepare(`INSERT INTO places(source_id,external_id,name,place_type,geo_area_id,address,centroid_lat,centroid_lon,description,source_url,raw_snapshot_id,metadata_json) VALUES('presidencia','palacio-la-moneda','Palacio de La Moneda','seat_of_government',?,'Calle Moneda 1202 - 1298',NULL,NULL,?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET geo_area_id=excluded.geo_area_id,address=excluded.address,centroid_lat=excluded.centroid_lat,centroid_lon=excluded.centroid_lon,description=excluded.description,source_url=excluded.source_url,raw_snapshot_id=excluded.raw_snapshot_id,metadata_json=excluded.metadata_json`).run(santiago,"Sede del Gobierno de Chile y edificio histórico del centro cívico de Santiago.",HISTORY,history.snapshotId,JSON.stringify(metadata));written=1;
    finishRun(run,"success","places=1",seen,written);return{seen,written};
  }catch(e){finishRun(run,"failed",String(e),seen,written);throw e}
}
