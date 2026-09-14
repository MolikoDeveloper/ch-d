const detail=document.querySelector('#communeDetail');
const communeSelect=document.querySelector('#communeSelect');
let electionSerial=0;
const intfmt=new Intl.NumberFormat('es-CL',{maximumFractionDigits:0});
const pctfmt=new Intl.NumberFormat('es-CL',{minimumFractionDigits:1,maximumFractionDigits:2});

function node(tag,text,cls){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);return e}
function pct(v){return v==null?'—':`${pctfmt.format(Number(v))}%`}
function num(v){return v==null?'—':intfmt.format(Number(v))}
function office(v){return({president:'Presidencia de la República',senator:'Senado',deputy:'Cámara de Diputadas y Diputados',mayor:'Alcaldía',councillor:'Concejo Municipal',regional_governor:'Gobernación Regional',regional_councillor:'Consejo Regional',constituent:'Convención Constitucional'})[v]||v}
function date(v){const s=String(v||'');return /^\d{4}-\d{2}-\d{2}$/.test(s)?s.split('-').reverse().join('-'):s||'Fecha no informada'}

async function renderElections(){
  const code=communeSelect?.value;if(!code||!detail)return;
  if(detail.querySelector(`[data-elections-for="${CSS.escape(code)}"]`))return;
  const token=++electionSerial;
  try{
    const r=await fetch(`/api/explorer/elections?code=${encodeURIComponent(code)}`);if(!r.ok)return;const elections=await r.json();if(token!==electionSerial||communeSelect.value!==code||!elections.length)return;
    const wrap=node('section',null,'election-section');wrap.dataset.electionsFor=code;
    const head=node('div',null,'election-heading');const title=node('div');title.append(node('h4','Resultados electorales'),node('small','Votos por candidatura · fuente: Servicio Electoral de Chile (SERVEL)'));head.append(title,node('span',`${elections.length} elecciones`,'source-label'));wrap.appendChild(head);
    elections.forEach((e,index)=>{
      const card=node('details',null,'election-card');card.open=index<2;
      const summary=node('summary'),left=node('div');left.append(node('b',office(e.office_type)),node('small',`${date(e.election_date)}${Number(e.round)>1?` · ${e.round}ª vuelta`:''} · ${e.status==='preliminary'?'Preliminar':'Definitivo'}`));summary.append(left,node('span',`${e.candidates.length} candidaturas`));card.appendChild(summary);
      const totals=node('div',null,'election-totals');for(const [label,value] of [['Válidamente emitidos',e.valid_votes],['Nulos',e.null_votes],['Blancos',e.blank_votes],['Total sufragios',e.total_votes]])if(value!=null){const item=node('span');item.append(node('small',label),node('b',num(value)));totals.append(item)}if(totals.children.length)card.appendChild(totals);
      const table=node('div',null,'election-table');const header=node('div',null,'election-row election-row-head');for(const h of['Candidatura','Partido / pacto','Votos','% válidos','% total'])header.append(node('span',h));table.appendChild(header);
      for(const c of e.candidates){const row=node('div',null,'election-row'),candidate=node('div',null,'election-candidate'),name=node('b',c.name);if(c.elected===true)name.append(node('em','Electo/a','elected-badge'));candidate.append(name);if(c.ballotNumber)candidate.append(node('small',`Nº ${c.ballotNumber}`));const political=node('div',null,'election-political');political.append(node('b',c.party||c.list||'Independencia/partido no informado'));if(c.coalition)political.append(node('small',c.coalition));const vote=node('strong',num(c.votes),'election-votes'),valid=node('div',null,'election-share'),total=node('strong',pct(c.totalVotePct),'election-total-share');valid.append(node('strong',pct(c.validVotePct)));const bar=node('i',null,'election-bar');bar.style.setProperty('--share',`${Math.max(0,Math.min(100,Number(c.validVotePct)||0))}%`);valid.append(bar);row.append(candidate,political,vote,valid,total);table.appendChild(row)}
      card.appendChild(table);card.appendChild(node('p','% válidos = candidatura / votos válidamente emitidos. % total = candidatura / total de sufragios cuando el archivo permite reconstruir nulos y blancos.','election-note'));wrap.appendChild(card)
    });
    detail.appendChild(wrap);
  }catch(e){console.error('No se pudieron cargar resultados electorales',e)}
}

if(detail)new MutationObserver(()=>queueMicrotask(renderElections)).observe(detail,{childList:true,subtree:true});
communeSelect?.addEventListener('change',()=>setTimeout(renderElections,0));
