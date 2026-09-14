const detail=document.querySelector('#communeDetail');
const communeSelect=document.querySelector('#communeSelect');
let requestSerial=0;

function cell(text,cls){const el=document.createElement('div');if(cls)el.className=cls;el.textContent=text;return el}
function positionLabel(authority){return authority.position||({mayor:'Alcalde/Alcaldesa',councillor:'Concejal/Concejala'}[authority.role]||authority.role||'Cargo no informado')}
function ageLabel(authority){return authority.age!=null&&Number.isFinite(Number(authority.age))?`${Number(authority.age)} años`:'No informada'}

async function enhanceAuthorities(){
  const code=communeSelect?.value;
  const section=detail?.querySelector('.authority-section');
  if(!code||!section||section.dataset.authorityTableFor===code)return;
  const serial=++requestSerial;
  try{
    const response=await fetch(`/api/explorer/commune?code=${encodeURIComponent(code)}`);
    if(!response.ok)return;
    const data=await response.json();
    if(serial!==requestSerial||communeSelect.value!==code)return;
    const authorities=data.authorities||[];
    if(!authorities.length)return;

    section.dataset.authorityTableFor=code;
    section.replaceChildren();

    const heading=document.createElement('div');heading.className='authority-heading';
    const title=document.createElement('h4');title.textContent='Autoridades municipales';
    const source=document.createElement('small');source.textContent=`Fuente: ${data.source||'SINIM / SUBDERE'}`;
    heading.append(title,source);section.appendChild(heading);

    const table=document.createElement('div');table.className='authority-table';
    const header=document.createElement('div');header.className='authority-row authority-table-head';
    for(const label of['Cargo','Nombre','Partido / condición política','Edad'])header.appendChild(cell(label));
    table.appendChild(header);

    for(const authority of authorities){
      const row=document.createElement('div');row.className='authority-row';
      row.appendChild(cell(positionLabel(authority),'authority-position'));
      row.appendChild(cell(authority.name||'No informado','authority-name'));
      row.appendChild(cell(authority.party||'No informado','authority-party'));
      const age=document.createElement('div');age.className='authority-age';
      const primary=document.createElement('span');primary.textContent=ageLabel(authority);age.appendChild(primary);
      if(authority.birthDate){const birth=document.createElement('small');birth.textContent=`Nacimiento: ${authority.birthDate}`;age.appendChild(birth)}
      row.appendChild(age);table.appendChild(row);
    }
    section.appendChild(table);

    const note=document.createElement('p');note.className='authority-note';
    note.textContent='La edad solo se muestra cuando existe una fecha de nacimiento respaldada por una fuente. No se infiere desde el nombre ni desde otras características.';
    section.appendChild(note);
  }catch(error){console.error('No se pudo ampliar la ficha de autoridades',error)}
}

if(detail){
  const observer=new MutationObserver(()=>queueMicrotask(enhanceAuthorities));
  observer.observe(detail,{childList:true,subtree:true});
}
communeSelect?.addEventListener('change',()=>setTimeout(enhanceAuthorities,0));
