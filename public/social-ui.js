const detail=document.querySelector('#communeDetail');
const commune=document.querySelector('#communeSelect');
let serial=0;
const fmt=new Intl.NumberFormat('es-CL',{maximumFractionDigits:1});
const intFmt=new Intl.NumberFormat('es-CL',{maximumFractionDigits:0});

function node(tag,text,cls){const x=document.createElement(tag);if(cls)x.className=cls;if(text!=null)x.textContent=String(text);return x}
function pct(v){return v==null?'—':`${fmt.format(Number(v))}%`}
function num(v){return v==null?'—':intFmt.format(Number(v))}
function metric(items,id){return items.find(x=>x.metric===id)}

async function renderSocial(){
  const code=commune?.value;if(!code||!detail)return;
  const current=detail.querySelector('.social-section');if(current?.dataset.code===code)return;
  const mine=++serial;
  const res=await fetch(`/api/explorer/commune?code=${encodeURIComponent(code)}`);if(!res.ok)return;
  const data=await res.json();if(mine!==serial||commune.value!==code)return;
  const items=data.socialIndicators||[];if(!items.length)return;
  detail.querySelectorAll('.social-section').forEach(x=>x.remove());

  const section=node('section',null,'social-section');section.dataset.code=code;
  const head=node('div',null,'social-heading');head.append(node('h4','Situación socioeconómica'),node('small',data.socialSource||'Registro Social de Hogares'));section.append(head);

  const values=[
    ['Personas presentes en RSH',num(metric(items,'rsh:persons:commune:total:count')?.value_number)],
    ['Tramos 0–70',pct(metric(items,'rsh:persons:commune:0-70:pct')?.value_number)],
    ['Tramos 71–100',pct(metric(items,'rsh:persons:commune:71-100:pct')?.value_number)],
    ['Tramo 91–100',pct(metric(items,'rsh:persons:commune:91-100:pct')?.value_number)],
  ];
  const cards=node('div',null,'social-cards');for(const [label,value] of values){const c=node('div',null,'social-card');c.append(node('small',label),node('b',value));cards.append(c)}section.append(cards);
  section.append(node('p','Los tramos CSE describen a personas u hogares presentes en el RSH. No equivalen automáticamente a una clasificación de clase social ni a toda la población.','social-note'));

  const units=data.socialUnits||[];
  if(units.length){const title=node('div',null,'social-unit-title');title.append(node('b','Unidades vecinales'),node('small',`${units.length} sectores`));section.append(title);const table=node('div',null,'social-unit-table');const header=node('div',null,'social-unit-row social-unit-head');for(const h of['Unidad vecinal','Personas','0–70','71–100','91–100'])header.append(node('span',h));table.append(header);for(const u of units){const row=node('div',null,'social-unit-row');row.append(node('span',u.code),node('span',num(u.totalPersons)),node('span',pct(u.lowerPct)),node('span',pct(u.higherPct)),node('span',pct(u.topPct)));table.append(row)}section.append(table)}

  const anchor=detail.querySelector('.authority-section')||detail.querySelector('.detail-head');if(anchor)anchor.insertAdjacentElement('afterend',section);else detail.prepend(section);
}

if(detail)new MutationObserver(()=>queueMicrotask(renderSocial)).observe(detail,{childList:true,subtree:true});
commune?.addEventListener('change',()=>setTimeout(renderSocial,0));
