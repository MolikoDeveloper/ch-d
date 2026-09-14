const detail=document.querySelector('#communeDetail');
const communeSelect=document.querySelector('#communeSelect');
let civicSerial=0;
function node(tag,text,cls){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);return e}
function placeType(v){return({seat_of_government:'Sede de Gobierno'})[v]||v}
async function renderPlaces(){
  const code=communeSelect?.value;if(!code||!detail)return;
  if(detail.querySelector(`[data-places-for="${CSS.escape(code)}"]`))return;
  const token=++civicSerial;
  try{
    const r=await fetch(`/api/explorer/places?code=${encodeURIComponent(code)}`);if(!r.ok)return;const places=await r.json();if(token!==civicSerial||communeSelect.value!==code||!places.length)return;
    const wrap=node('section',null,'civic-place-section');wrap.dataset.placesFor=code;
    for(const p of places){const card=node('article',null,'civic-place-card');card.append(node('h4',p.name),node('small',`${placeType(p.type)} · ${p.address||'Dirección no informada'}`),node('p',p.description||''));const facts=node('div',null,'civic-place-facts'),m=p.metadata||{};for(const [label,value] of [['Arquitecto',m.architect],['Uso original',m.originalUse],['Inauguración',m.inauguratedYear],['Sede de Gobierno desde',m.governmentSeatSince],['Protección patrimonial',m.heritageStatus],['Declaratoria',m.heritageDecree]])if(value!=null){const f=node('span');f.append(node('small',label),node('b',value));facts.append(f)}if(facts.children.length)card.append(facts);if(p.sourceUrl){const source=node('small','Fuente: Presidencia / patrimonio oficial');card.append(source)}wrap.append(card)}
    const anchor=detail.querySelector('.detail-head');if(anchor)anchor.insertAdjacentElement('afterend',wrap);else detail.prepend(wrap);
  }catch(e){console.error('No se pudieron cargar lugares cívicos',e)}
}
if(detail)new MutationObserver(()=>queueMicrotask(renderPlaces)).observe(detail,{childList:true,subtree:true});
communeSelect?.addEventListener('change',()=>setTimeout(renderPlaces,0));
