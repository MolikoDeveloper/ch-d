import { db } from "../db";

const rows=(q:string,...p:any[])=>db.query(q).all(...p) as any[];
const one=(q:string,...p:any[])=>db.query(q).get(...p) as any|null;

function commune(code:string){return one(`SELECT id,code,name FROM geo_areas WHERE geo_type='commune' AND code=? ORDER BY CASE source_id WHEN 'ide-chile' THEN 0 ELSE 1 END,id LIMIT 1`,code)}

export function communeElectionResults(code:string){
  const c=commune(code);if(!c)return[];
  const elections=rows(`
    SELECT DISTINCT e.id,e.external_id,e.name,e.office_type,e.election_date,e.round,e.territorial_scope,e.status,e.source_url,
           t.valid_votes,t.null_votes,t.blank_votes,t.total_votes,t.registered_voters,t.turnout_pct
    FROM election_results r
    JOIN elections e ON e.id=r.election_id
    LEFT JOIN election_totals t ON t.election_id=e.id AND t.geo_area_id=r.geo_area_id
    WHERE r.geo_area_id=?
    ORDER BY COALESCE(e.election_date,'') DESC,e.office_type,e.round
  `,c.id);
  const candidateRows=rows(`
    SELECT r.election_id,c.candidate_name,c.party,c.coalition,c.list_name,c.ballot_number,
           r.votes,r.valid_vote_pct,r.total_vote_pct,r.position,r.elected
    FROM election_results r JOIN election_candidates c ON c.id=r.candidate_id
    WHERE r.geo_area_id=?
    ORDER BY r.election_id,r.position,r.votes DESC,c.candidate_name
  `,c.id),by=new Map<number,any[]>();
  for(const r of candidateRows){const list=by.get(r.election_id)??[];list.push({name:r.candidate_name,party:r.party,coalition:r.coalition,list:r.list_name,ballotNumber:r.ballot_number,votes:r.votes,validVotePct:r.valid_vote_pct,totalVotePct:r.total_vote_pct,position:r.position,elected:r.elected==null?null:Boolean(r.elected)});by.set(r.election_id,list)}
  return elections.map(e=>({...e,candidates:by.get(e.id)??[]}));
}

export function communePlaces(code:string){
  const c=commune(code);if(!c)return[];
  return rows(`SELECT id,name,place_type,address,centroid_lat,centroid_lon,description,source_url,metadata_json FROM places WHERE geo_area_id=? ORDER BY name`,c.id).map(p=>{let metadata={};try{metadata=JSON.parse(p.metadata_json||"{}")}catch{}return{id:p.id,name:p.name,type:p.place_type,address:p.address,lat:p.centroid_lat,lon:p.centroid_lon,description:p.description,sourceUrl:p.source_url,metadata}})
}
