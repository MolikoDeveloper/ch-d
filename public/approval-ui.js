const economy=document.querySelector('#economia');
const fmt=new Intl.NumberFormat('es-CL',{maximumFractionDigits:1});
function node(tag,text,cls){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);return e}
async function latest(source,metric){try{const r=await fetch(`/api/observations?source=${encodeURIComponent(source)}&metric=${encodeURIComponent(metric)}&limit=1`);if(!r.ok)return null;return(await r.json())[0]??null}catch{return null}}
async function renderApproval(){
  if(!economy||document.querySelector('#approval'))return;
  const specs=[['criteria','Agenda Criteria'],['cadem','Plaza Pública Cadem']],groups=[];
  for(const [source,label] of specs){const [approval,disapproval]=await Promise.all([latest(source,`${source}:presidential_approval_pct`),latest(source,`${source}:presidential_disapproval_pct`)]);if(approval||disapproval)groups.push({source,label,approval,disapproval})}
  if(!groups.length)return;
  const section=node('section',null,'economy-strip-section');section.id='approval';const head=node('div',null,'section-title'),title=node('div');title.append(node('h2','Aprobación presidencial'),node('small','Encuestas de opinión · series separadas por encuestadora'));head.append(title);section.append(head);
  const strip=node('div',null,'fact-strip');for(const g of groups){const card=node('div',null,'fact-item'),date=g.approval?.observed_at||g.disapproval?.observed_at||'—',a=g.approval?.value_number,d=g.disapproval?.value_number;card.append(node('small',g.label),node('b',a==null?'—':`${fmt.format(Number(a))}% aprueba`),node('em',`${d==null?'—':`${fmt.format(Number(d))}% desaprueba`} · ${date}`));strip.append(card)}section.append(strip);section.append(node('p','Estas cifras provienen de encuestas de opinión privadas y dependen de la metodología, muestra y fecha de cada estudio. No se promedian entre encuestadoras ni se presentan como estadística oficial.','social-note'));economy.insertAdjacentElement('afterend',section)
}
renderApproval();
