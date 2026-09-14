const $=q=>document.querySelector(q);
const fmt=new Intl.NumberFormat('es-CL',{maximumFractionDigits:2});
const integer=new Intl.NumberFormat('es-CL',{maximumFractionDigits:0});
const compact=new Intl.NumberFormat('es-CL',{notation:'compact',maximumFractionDigits:1});
const money=n=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}).format(Number(n)||0);

let map,featureLayer,allFeatures=[],mapLayers=[];
let refreshTimer=null;

function el(tag,text,cls){const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=String(text);return n}
function dateOnly(v){return v?String(v).slice(0,10):null}
function formatValue(value,unit){
  if(value==null||value==='')return '—';
  const n=Number(value);if(!Number.isFinite(n))return String(value);
  const u=String(unit||'').toLowerCase();
  if(u==='clp'||u.includes('peso'))return money(n);
  if(u.includes('%')||u.includes('porcentaje'))return `${fmt.format(n)}%`;
  if(Math.abs(n)>=1_000_000)return compact.format(n);
  return fmt.format(n);
}
function sourceMeta(item,source){return [item.territory,dateOnly(item.date),source].filter(Boolean).join(' · ')}

function initMap(){
  map=L.map('map',{zoomControl:true,preferCanvas:true,minZoom:3,maxZoom:18});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
  map.fitBounds([[-56.3,-76.8],[-17.2,-66.0]],{padding:[10,10]});
  featureLayer=L.layerGroup().addTo(map);
}

function layerMeta(id){return mapLayers.find(x=>x.id===id)||mapLayers[0]||{id:'geography',label:'Geografía oficial',source:'IDE Chile',unit:null,scale:'none'}}
function layerValue(feature,id){return feature.properties?.values?.[id]?.value}
function normalizedIntensity(value,min,max,scale){
  if(value==null||!Number.isFinite(Number(value)))return null;
  const n=Number(value);
  if(max===min)return 1;
  if(scale==='log'&&min>=0)return Math.log1p(Math.max(0,n))/Math.log1p(Math.max(1,max));
  return Math.max(0,Math.min(1,(n-min)/(max-min)));
}
function renderMap(kind){
  featureLayer.clearLayers();
  const meta=layerMeta(kind),values=allFeatures.map(f=>Number(layerValue(f,meta.id))).filter(Number.isFinite);
  const min=values.length?Math.min(...values):0,max=values.length?Math.max(...values):1;
  $('#mapLegendTitle').textContent=meta.label;
  $('#mapLegendUnit').textContent=meta.unit?`Unidad: ${meta.unit}`:'División político-administrativa';
  $('#mapLegendSource').textContent=`Fuente: ${meta.source}`;
  $('#mapSource').textContent=`${meta.source}${meta.unit?` · ${meta.unit}`:''}`;

  for(const f of allFeatures){
    if(!['Polygon','MultiPolygon'].includes(f.geometry?.type))continue;
    const p=f.properties||{},entry=p.values?.[meta.id]||null;
    const intensity=meta.id==='geography'?null:normalizedIntensity(entry?.value,min,max,meta.scale);
    const fillOpacity=meta.id==='geography'?.08:(intensity==null?.035:.14+intensity*.58);
    const layer=L.geoJSON(f,{style:{weight:meta.id==='geography'?1.5:1,fillOpacity}});
    const detail=meta.id==='geography'
      ? `${p.label} · código ${p.code||'—'}`
      : entry
        ? `${p.label} — ${meta.label}: ${formatValue(entry.value,meta.unit)}${entry.date?` — ${dateOnly(entry.date)}`:''}${entry.count!=null?` — ${integer.format(entry.count)} registros`:''}`
        : `${p.label} — sin dato para ${meta.label}`;
    layer.bindTooltip(document.createTextNode(p.label||'Región'),{sticky:true,direction:'top'});
    layer.bindPopup(document.createTextNode(`${detail} — Fuente: ${meta.source}`));
    layer.addTo(featureLayer);
  }
}
function configureMap(data){
  mapLayers=data.layers||[{id:'geography',label:'Geografía oficial',source:'IDE Chile',unit:null,scale:'none'}];
  allFeatures=data.features||[];
  const select=$('#mapLayer'),previous=select.value;
  select.replaceChildren();
  for(const layer of mapLayers){const o=el('option',layer.label);o.value=layer.id;select.appendChild(o)}
  select.value=mapLayers.some(x=>x.id===previous)?previous:(mapLayers.find(x=>x.id==='purchases')?.id||mapLayers[0]?.id||'geography');
  renderMap(select.value);
}

function renderHeadline(items){
  const box=$('#headlineCards');box.replaceChildren();
  for(const x of items||[]){
    const card=el('article'),body=el('div');
    body.append(el('small',x.label),el('strong',x.format==='money'?money(x.value):x.format==='integer'?integer.format(Number(x.value)||0):formatValue(x.value,x.unit)));
    body.append(el('em',[dateOnly(x.date),x.source].filter(Boolean).join(' · ')||'Dato no disponible'));
    card.append(body);box.append(card);
  }
}
function renderIndicators(items,selector,source,empty){
  const box=$(selector);box.replaceChildren();
  if(!items?.length){box.appendChild(el('div',empty,'empty-state'));return}
  for(const x of items){
    const row=el('div',null,'series-row'),info=el('div');
    info.append(el('b',x.label||x.title),el('small',sourceMeta(x,source)));
    row.append(info,el('strong',formatValue(x.value,x.unit)));box.appendChild(row);
  }
}
function renderPurchases(data){
  $('#ccAmount').textContent=money(data.amount||0);$('#ccOrders').textContent=integer.format(data.orders||0);$('#ccBuyers').textContent=integer.format(data.buyers||0);$('#ccSuppliers').textContent=integer.format(data.suppliers||0);
  const box=$('#ccRegions');box.replaceChildren();
  if(!data.byRegion?.length){box.appendChild(el('div','Sin compras georreferenciadas disponibles.','empty-state'));return}
  const max=Math.max(...data.byRegion.map(x=>Number(x.amount)||0),1);
  for(const x of data.byRegion){const row=el('div',null,'bar-row');row.append(el('span',x.region||'Sin región'));const track=el('div',null,'bar-track'),fill=el('i',null,'bar-fill');fill.style.width=`${Math.max(2,(Number(x.amount)||0)/max*100)}%`;track.appendChild(fill);row.append(track,el('b',compact.format(Number(x.amount)||0)));box.appendChild(row)}
}
function renderMunicipal(data){
  $('#sinimCommunes').textContent=integer.format(data.communes||0);$('#sinimMayors').textContent=integer.format(data.mayors||0);$('#sinimCouncillors').textContent=integer.format(data.councillors||0);
  renderIndicators(data.indicators,'#sinimIndicators',data.source,'Sin indicadores municipales disponibles.');
}

async function loadDashboard(){
  if(document.hidden)return;
  const dash=await fetch('/api/dashboard').then(r=>r.json());
  renderHeadline(dash.headline||[]);
  renderIndicators(dash.economy?.indicators,'#economicSeries',dash.economy?.source,'Sin indicadores económicos disponibles.');
  renderPurchases(dash.purchases||{});
  renderMunicipal(dash.municipal||{});
  renderIndicators(dash.labor?.indicators,'#laborIndicators',dash.labor?.source,'Sin indicadores laborales disponibles.');
  renderIndicators(dash.energy?.indicators,'#energyIndicators',dash.energy?.source,'Sin indicadores energéticos disponibles.');
}
async function loadMap(){if(document.hidden)return;configureMap(await fetch('/api/map/features').then(r=>r.json()))}
async function refresh(){await Promise.all([loadDashboard(),loadMap()])}
function startTimer(){if(refreshTimer)clearInterval(refreshTimer);refreshTimer=setInterval(()=>refresh().catch(console.error),300000)}

initMap();
$('#mapLayer').addEventListener('change',e=>renderMap(e.target.value));
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(refreshTimer)clearInterval(refreshTimer);refreshTimer=null}else{refresh().catch(console.error);startTimer()}});
refresh().then(startTimer).catch(console.error);
