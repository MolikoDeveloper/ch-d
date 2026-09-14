const detail=document.querySelector('#communeDetail');
const communeSelect=document.querySelector('#communeSelect');
let serial=0;
const fmt=new Intl.NumberFormat('es-CL',{maximumFractionDigits:2});
const intfmt=new Intl.NumberFormat('es-CL',{maximumFractionDigits:0});

function value(v,unit){if(v==null||v==='')return'—';const n=Number(v);if(!Number.isFinite(n))return String(v);const u=String(unit||'').toLowerCase();if(u.includes('%'))return`${fmt.format(n)}%`;if(u==='n°'||u.includes('person')||u.includes('hogar'))return intfmt.format(n);if(u==='clp')return new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}).format(n);return`${fmt.format(n)}${unit?` ${unit}`:''}`}
function node(tag,text,cls){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}

async function renderRelated(){
  const code=communeSelect?.value;if(!code||!detail)return;
  if(detail.querySelector(`[data-context-for="${CSS.escape(code)}"]`))return;
  const token=++serial;
  try{
    const r=await fetch(`/api/explorer/commune?code=${encodeURIComponent(code)}`);if(!r.ok)return;const data=await r.json();if(token!==serial||communeSelect.value!==code)return;
    const groups=(data.relatedSources||[]).filter(x=>x.indicators?.length);if(!groups.length)return;
    const wrap=node('section',null,'context-section');wrap.dataset.contextFor=code;
    const h=node('div',null,'context-heading');h.append(node('h4','Contexto comunal desde otras fuentes'),node('small','Cada bloque mantiene su fuente y período.'));wrap.appendChild(h);
    for(const group of groups){const box=node('details',null,'context-source');box.open=true;const summary=node('summary');summary.append(node('b',group.source),node('span',`${group.indicators.length} datos`));box.appendChild(summary);const table=node('div',null,'context-table');for(const x of group.indicators){const row=node('div',null,'context-row'),left=node('div');left.append(node('b',x.title),node('small',`${x.observed_at||'Período no informado'}${x.subcategory?` · ${x.subcategory}`:''}`));row.append(left,node('strong',value(x.value_number??x.value_text,x.unit)));table.appendChild(row)}box.appendChild(table);wrap.appendChild(box)}
    detail.appendChild(wrap);
  }catch(e){console.error('No se pudo cargar contexto comunal',e)}
}

if(detail){new MutationObserver(()=>queueMicrotask(renderRelated)).observe(detail,{childList:true,subtree:true})}
communeSelect?.addEventListener('change',()=>setTimeout(renderRelated,0));
