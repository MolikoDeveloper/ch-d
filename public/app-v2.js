const $=q=>document.querySelector(q);
const fmt=new Intl.NumberFormat('es-CL',{maximumFractionDigits:2});
const integer=new Intl.NumberFormat('es-CL',{maximumFractionDigits:0});
const money=n=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}).format(Number(n)||0);
const compact=new Intl.NumberFormat('es-CL',{notation:'compact',maximumFractionDigits:1});

let map,regionLayer,communeLayer;
let territories={regions:[],communes:[]};
let regionFeatures=[];
let metrics=[];
let indicatorData=null;
let selectedRegion='';
let selectedCommune='';
let refreshTimer=null;

function el(tag,text,cls){const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=String(text);return n}
function dateOnly(v){return v?String(v).slice(0,10):'—'}
function formatValue(v,unit){
  if(v==null||v==='')return '—';
  const n=Number(v);if(!Number.isFinite(n))return String(v);
  const u=String(unit||'').toLowerCase();
  if(u==='clp'||u.includes('peso'))return money(n);
  if(u.includes('%')||u.includes('porcentaje'))return `${fmt.format(n)}%`;
  if(Math.abs(n)>=1_000_000)return compact.format(n);
  return fmt.format(n);
}
function normalize(v){return String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()}
function intensity(value,min,max){if(value==null||!Number.isFinite(Number(value)))return null;if(max===min)return 1;return Math.max(0,Math.min(1,(Number(value)-min)/(max-min)))}
function colorFor(t){if(t==null)return '#b9c7d8';const hue=215-Math.round(t*105);return `hsl(${hue} 68% 48%)`}

function initMap(){
  map=L.map('map',{zoomControl:true,preferCanvas:true,minZoom:3,maxZoom:17});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
  regionLayer=L.layerGroup().addTo(map);communeLayer=L.layerGroup().addTo(map);resetMap();
}
function resetMap(){map.fitBounds([[-56.3,-76.8],[-17.2,-66.0]],{padding:[10,10]})}
function regionFeature(code){return regionFeatures.find(f=>String(f.properties?.code)===String(code))}
function communeByCode(code){return territories.communes.find(c=>String(c.code)===String(code))}

function renderMap(){
  regionLayer.clearLayers();communeLayer.clearLayers();
  const mode=$('#mapMode').value,source=$('#indicatorSource').value,metric=metrics.find(x=>x.metric===$('#indicatorSelect').value),values=indicatorData?.values||[];
  const regionValues=new Map(values.filter(v=>v.geo_type==='region').map(v=>[String(v.code),v]));
  const communeValues=new Map(values.filter(v=>v.geo_type==='commune').map(v=>[String(v.code),v]));
  const hasCommuneValues=communeValues.size>0;
  const numeric=mode==='purchases'
    ? regionFeatures.map(f=>Number(f.properties?.purchases?.amount)).filter(Number.isFinite)
    : values.map(v=>Number(v.value_number)).filter(Number.isFinite);
  const min=numeric.length?Math.min(...numeric):0,max=numeric.length?Math.max(...numeric):1;

  $('#mapTitle').textContent=mode==='indicator'&&metric?metric.title:mode==='purchases'?'Compras públicas por región':'Mapa territorial';
  $('#mapSource').textContent=mode==='indicator'?(indicatorData?.source||source):mode==='purchases'?'ChileCompra / Mercado Público':'IDE Chile · SINIM';
  $('#mapLegendTitle').textContent=mode==='indicator'&&metric?metric.title:mode==='purchases'?'Monto registrado':'Territorios';
  $('#mapLegendUnit').textContent=mode==='indicator'?(metric?.unit?`Unidad: ${metric.unit}`:'Valor publicado'):mode==='purchases'?'CLP por región':'Regiones y comunas';
  $('#mapLegendSource').textContent=`Fuente: ${mode==='indicator'?(indicatorData?.source||source):mode==='purchases'?'ChileCompra':'IDE Chile / SINIM'}`;

  for(const feature of regionFeatures){
    const p=feature.properties||{},code=String(p.code||'');let value=null,detail='';
    if(mode==='purchases'){value=Number(p.purchases?.amount||0);detail=`${money(value)} · ${integer.format(p.purchases?.orders||0)} órdenes`}
    else if(mode==='indicator'&&regionValues.has(code)){const v=regionValues.get(code);value=v.value_number;detail=`${formatValue(v.value_number??v.value_text,metric?.unit)} · ${dateOnly(v.observed_at)}`}
    const t=mode==='geography'?null:intensity(value,min,max);
    const layer=L.geoJSON(feature,{style:{weight:selectedRegion===code?3:1.2,color:selectedRegion===code?'#0a4fb8':'#6f86a3',fillColor:colorFor(t),fillOpacity:mode==='geography' ? .08 : (t==null ? .04 : .16+t*.58)}});
    layer.bindTooltip(document.createTextNode(p.name||'Región'),{sticky:true});
    layer.bindPopup(document.createTextNode(detail?`${p.name} — ${detail}`:`${p.name} — Región ${p.code}`));
    layer.on('click',()=>selectRegion(code,true));layer.addTo(regionLayer);
  }

  const showCommunes=mode==='geography'||(mode==='indicator'&&hasCommuneValues);
  if(!showCommunes)return;
  for(const c of filteredCommunes(false)){
    if(c.centroid_lat==null||c.centroid_lon==null)continue;
    const valueEntry=communeValues.get(String(c.code));
    if(mode==='indicator'&&!valueEntry)continue;
    const t=mode==='indicator'?intensity(valueEntry?.value_number,min,max):null,selected=selectedCommune===String(c.code);
    const marker=L.circleMarker([Number(c.centroid_lat),Number(c.centroid_lon)],{radius:selected?8:mode==='indicator'?5.5:4,weight:selected?3:1,color:selected?'#092f6f':'#fff',fillColor:mode==='indicator'?colorFor(t):'#1769e0',fillOpacity:.9});
    const valueText=mode==='indicator'&&valueEntry?` — ${formatValue(valueEntry.value_number??valueEntry.value_text,metric?.unit)}`:'';
    marker.bindTooltip(document.createTextNode(`${c.name}${valueText}`),{direction:'top'});
    marker.bindPopup(document.createTextNode(`${c.name} — ${c.region_name}${valueText}${valueEntry?.observed_at?` — ${dateOnly(valueEntry.observed_at)}`:''}`));
    marker.on('click',()=>selectCommune(String(c.code),true));marker.addTo(communeLayer);
  }
}

function filteredCommunes(useSearch=true){const q=useSearch?normalize($('#territorySearch').value):'';return territories.communes.filter(c=>(!selectedRegion||String(c.region_code)===String(selectedRegion))&&(!q||normalize(`${c.name} ${c.region_name} ${c.code}`).includes(q)))}
function populateRegions(){const select=$('#regionSelect');select.replaceChildren(el('option','Todas las regiones'));select.firstChild.value='';for(const r of territories.regions){const o=el('option',r.name);o.value=r.code;select.appendChild(o)}}
function populateCommuneSelect(){const list=filteredCommunes(false),select=$('#communeSelect');select.replaceChildren(el('option','Selecciona una comuna'));select.firstChild.value='';for(const c of list){const o=el('option',`${c.name} · ${c.region_name}`);o.value=c.code;select.appendChild(o)}if(selectedCommune&&list.some(c=>String(c.code)===selectedCommune))select.value=selectedCommune}
function renderCommuneList(){
  const list=filteredCommunes(true),box=$('#communeList');box.replaceChildren();$('#communeResultCount').textContent=integer.format(list.length);$('#territoryCount').textContent=`${integer.format(territories.regions.length)} regiones · ${integer.format(territories.communes.length)} comunas`;
  for(const c of list){const b=el('button',null,`commune-row${selectedCommune===String(c.code)?' selected':''}`);b.type='button';const left=el('span');left.append(el('b',c.name),el('small',`${c.region_name} · ${c.code}`));b.append(left,el('small',`${integer.format(c.indicator_rows||0)} datos`));b.addEventListener('click',()=>selectCommune(String(c.code),true));box.appendChild(b)}
  if(!list.length)box.appendChild(el('div','No hay comunas que coincidan con el filtro.','empty-state'));
}
function resetDetail(){const box=$('#communeDetail');box.replaceChildren();const d=el('div',null,'detail-placeholder');d.append(el('h3','Selecciona una comuna'),el('p','Verás todos los indicadores municipales disponibles, autoridades y períodos publicados por SINIM.'));box.appendChild(d)}
function selectRegion(code,zoom=false){
  selectedRegion=String(code||'');selectedCommune='';$('#regionSelect').value=selectedRegion;populateCommuneSelect();$('#communeSelect').value='';renderCommuneList();resetDetail();renderMap();
  if(zoom&&selectedRegion){const f=regionFeature(selectedRegion);if(f)map.fitBounds(L.geoJSON(f).getBounds(),{padding:[20,20]})}
}
async function selectCommune(code,zoom=false){
  const c=communeByCode(code);if(!c)return;selectedCommune=String(code);selectedRegion=String(c.region_code||'');$('#regionSelect').value=selectedRegion;populateCommuneSelect();$('#communeSelect').value=selectedCommune;renderCommuneList();renderMap();
  $('#communeDetail').replaceChildren(el('div','Cargando ficha comunal…','empty-state'));
  const profile=await fetch(`/api/explorer/commune?code=${encodeURIComponent(code)}`).then(r=>r.json());renderCommuneProfile(profile);
  if(zoom&&c.centroid_lat!=null&&c.centroid_lon!=null)map.setView([Number(c.centroid_lat),Number(c.centroid_lon)],10);
}

function renderCommuneProfile(data){
  const box=$('#communeDetail');box.replaceChildren();if(data.error){box.appendChild(el('div',data.error,'empty-state'));return}
  const c=data.commune,head=el('div',null,'detail-head'),title=el('div');title.append(el('h3',c.name),el('small',`${c.region_name} · código ${c.code} · ${data.source}`));head.append(title,el('span',`${data.indicators.length} indicadores`,'source-label'));box.appendChild(head);
  const mayor=data.authorities.find(a=>a.role==='mayor'),councillors=data.authorities.filter(a=>a.role==='councillor'),authority=el('section',null,'authority-section');authority.appendChild(el('h4','Autoridades municipales'));
  if(mayor){const card=el('div',null,'authority-major');card.append(el('b',mayor.name),el('span','Alcalde/sa'),el('small',mayor.party||'Sin afiliación informada'));authority.appendChild(card)}
  if(councillors.length){const list=el('div',null,'councillor-grid');for(const a of councillors){const item=el('div');item.append(el('b',a.name),el('small',a.party||'Sin afiliación informada'));list.appendChild(item)}authority.appendChild(list)}
  if(mayor||councillors.length)box.appendChild(authority);
  const groups=new Map();for(const item of data.indicators){const key=item.subcategory||'Otros datos';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item)}
  for(const [section,items] of groups){const details=document.createElement('details');details.className='indicator-section';details.open=true;const summary=document.createElement('summary');summary.append(el('b',section),el('span',`${items.length} indicadores`));details.appendChild(summary);const table=el('div',null,'indicator-table');for(const x of items){const row=el('div',null,'indicator-row'),name=el('div');name.append(el('b',x.title),el('small',`${dateOnly(x.observed_at)}${x.unit?` · ${x.unit}`:''}`));row.append(name,el('strong',x.value_number!=null?formatValue(x.value_number,x.unit):(x.value_text??'—')));table.appendChild(row)}details.appendChild(table);box.appendChild(details)}
}

async function loadMetrics(source){
  metrics=await fetch(`/api/explorer/metrics?source=${encodeURIComponent(source)}`).then(r=>r.json());const select=$('#indicatorSelect');select.replaceChildren(el('option',metrics.length?'Selecciona un indicador':'Sin indicadores territoriales'));select.firstChild.value='';
  const groups=new Map();for(const m of metrics){const key=m.subcategory||'Otros';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(m)}for(const [label,items] of groups){const group=document.createElement('optgroup');group.label=label;for(const m of items){const o=el('option',m.title);o.value=m.metric;group.appendChild(o)}select.appendChild(group)}
  const preferred=metrics.find(m=>/poblaci[oó]n comunal/i.test(m.title))||metrics.find(m=>/poblaci/i.test(m.title))||metrics[0];if(preferred){select.value=preferred.metric;await loadIndicator(preferred.metric)}else{indicatorData=null;$('#mapMode').value='geography';renderMap()}
}
async function loadIndicator(metric){if(!metric){indicatorData=null;renderMap();return}const source=$('#indicatorSource').value;indicatorData=await fetch(`/api/explorer/map?source=${encodeURIComponent(source)}&metric=${encodeURIComponent(metric)}`).then(r=>r.json());$('#mapMode').value='indicator';renderMap()}

function renderPanorama(data){
  const econ=$('#economyStrip');econ.replaceChildren();for(const x of data.economy||[]){const card=el('div',null,'fact-item');card.append(el('small',x.label),el('b',formatValue(x.value,x.unit)),el('em',`${dateOnly(x.date)} · ${x.source}`));econ.appendChild(card)}if(!econ.children.length)econ.appendChild(el('div','Sin indicadores económicos disponibles.','empty-state'));
  const p=data.purchases||{},pbox=$('#purchaseFacts');pbox.replaceChildren();for(const [label,value,format] of [['Monto registrado',p.amount,'money'],['Órdenes',p.orders,'integer'],['Compradores',p.buyers,'integer'],['Proveedores',p.suppliers,'integer']]){const card=el('div',null,'fact-item');card.append(el('small',label),el('b',format==='money'?money(value):integer.format(Number(value)||0)),el('em',p.source||'ChileCompra'));pbox.appendChild(card)}
  $('#coverageLabel').textContent=`${integer.format(data.territory?.regions||0)} regiones · ${integer.format(data.territory?.communes||0)} comunas`;
}

async function loadInitial(){const [panorama,territoryData,mapData]=await Promise.all([fetch('/api/panorama').then(r=>r.json()),fetch('/api/explorer/territories').then(r=>r.json()),fetch('/api/map/regions').then(r=>r.json())]);territories=territoryData;regionFeatures=mapData.features||[];renderPanorama(panorama);populateRegions();populateCommuneSelect();renderCommuneList();await loadMetrics($('#indicatorSource').value);renderMap()}
async function refreshOverview(){if(document.hidden)return;renderPanorama(await fetch('/api/panorama').then(r=>r.json()))}

initMap();
$('#resetMap').addEventListener('click',resetMap);
$('#regionSelect').addEventListener('change',e=>selectRegion(e.target.value,true));
$('#communeSelect').addEventListener('change',e=>{if(e.target.value)selectCommune(e.target.value,true);else{selectedCommune='';resetDetail();renderCommuneList();renderMap()}});
$('#territorySearch').addEventListener('input',renderCommuneList);
$('#indicatorSource').addEventListener('change',e=>loadMetrics(e.target.value).catch(console.error));
$('#indicatorSelect').addEventListener('change',e=>loadIndicator(e.target.value).catch(console.error));
$('#mapMode').addEventListener('change',renderMap);
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(refreshTimer)clearInterval(refreshTimer);refreshTimer=null}else{refreshOverview().catch(console.error);refreshTimer=setInterval(()=>refreshOverview().catch(console.error),300000)}});
loadInitial().then(()=>{refreshTimer=setInterval(()=>refreshOverview().catch(console.error),300000)}).catch(console.error);
