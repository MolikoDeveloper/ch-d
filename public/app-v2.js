const $=q=>document.querySelector(q);
const fmt=new Intl.NumberFormat('es-CL');
const compact=new Intl.NumberFormat('es-CL',{notation:'compact',maximumFractionDigits:1});
const money=n=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}).format(Number(n)||0);
let map,featureLayer,allFeatures=[];

function el(tag,text,cls){const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=String(text);return n}
function formatValue(v){if(v==null||v===''||Number.isNaN(Number(v)))return '—';const n=Number(v);return Number.isFinite(n)?new Intl.NumberFormat('es-CL',{maximumFractionDigits:3}).format(n):String(v)}
function formatDate(v){return v?new Date(v).toLocaleString('es-CL',{dateStyle:'medium',timeStyle:'short'}):'—'}

function initMap(){map=L.map('map',{zoomControl:true,preferCanvas:true,minZoom:3,maxZoom:18});L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);map.fitBounds([[-56.3,-76.8],[-17.2,-66.0]],{padding:[10,10]});featureLayer=L.layerGroup().addTo(map)}
function renderMap(kind='combined'){
  featureLayer.clearLayers();
  for(const f of allFeatures){
    const p=f.properties||{};
    if(f.geometry?.type==='Polygon'||f.geometry?.type==='MultiPolygon'){
      const layer=L.geoJSON(f,{style:{weight:1,fillOpacity:.24}});
      layer.bindPopup(document.createTextNode(`${p.label||p.geo_name||'Área'} — ${fmt.format(p.transactions||0)} transacciones`));
      layer.addTo(featureLayer);continue;
    }
    if(kind!=='combined'&&p.kind!==kind)continue;
    if(f.geometry?.type!=='Point')continue;
    const [lon,lat]=f.geometry.coordinates;
    const marker=L.circleMarker([lat,lon],{radius:6,weight:1,color:'#fff',fillColor:p.kind==='transaction'?'#1769e0':'#d93045',fillOpacity:.86});
    marker.bindPopup(document.createTextNode([p.label,p.geo_name,p.date?.slice?.(0,10),formatValue(p.value)].filter(Boolean).join(' — '))).addTo(featureLayer);
  }
}

function renderSources(sources){const select=$('#sourceFilter');select.replaceChildren(el('option','Todas'));select.firstChild.value='';for(const s of sources){const o=el('option',s.name);o.value=s.id;select.appendChild(o)}}
function renderEconomic(series){const box=$('#economicSeries');box.replaceChildren();if(!series.length){box.appendChild(el('div','Aún no hay series económicas normalizadas.','empty-state'));return}for(const s of series){const row=el('div',null,'series-row');const info=el('div');info.append(el('b',s.label),el('small',`${s.metric} · ${s.frequency||'frecuencia desconocida'} · ${s.date?.slice?.(0,10)??'sin fecha'}`));row.append(info,el('strong',formatValue(s.value)));box.appendChild(row)}}
function renderSpend(items){const box=$('#spendChart');box.replaceChildren();if(!items.length){box.appendChild(el('div','Sin transacciones con monto normalizadas todavía.','empty-state'));return}const max=Math.max(...items.map(x=>Number(x.total)||0),1);for(const x of items){const row=el('div',null,'bar-row');row.append(el('span',x.category));const track=el('div',null,'bar-track'),fill=el('i',null,'bar-fill');fill.style.width=`${Math.max(3,(Number(x.total)||0)/max*100)}%`;track.appendChild(fill);row.append(track,el('b',compact.format(Number(x.total)||0)));box.appendChild(row)}}
function renderProjects(items){const box=$('#projectStatus');box.replaceChildren();if(!items.length){box.appendChild(el('div','Sin proyectos normalizados todavía.','empty-state'));return}for(const x of items){const row=el('div',null,'status-row');row.append(el('span',x.status),el('b',fmt.format(x.count)));box.appendChild(row)}}
function renderChileCompra(data){
  $('#ccOrders').textContent=fmt.format(data.orders||0);$('#ccAmount').textContent=money(data.amount||0);$('#ccBuyers').textContent=fmt.format(data.buyers||0);$('#ccSuppliers').textContent=fmt.format(data.suppliers||0);
  const box=$('#ccRegions');box.replaceChildren();if(!data.byRegion?.length){box.appendChild(el('div','Sin compras georreferenciadas todavía.','empty-state'));return}
  const max=Math.max(...data.byRegion.map(x=>Number(x.amount)||0),1);for(const x of data.byRegion){const row=el('div',null,'bar-row');row.append(el('span',x.region||'Sin región'));const track=el('div',null,'bar-track'),fill=el('i',null,'bar-fill');fill.style.width=`${Math.max(3,(Number(x.amount)||0)/max*100)}%`;track.appendChild(fill);row.append(track,el('b',compact.format(Number(x.amount)||0)));box.appendChild(row)}
}
function renderIngest(status,activeRuns){const total=Object.values(status).reduce((a,b)=>a+Number(b||0),0);const done=Number(status.parsed||0)+Number(status.downloaded||0)+Number(status.unsupported||0);const pct=total?Math.round(done/total*100):0;$('#progressPercent').textContent=`${pct}%`;document.documentElement.style.setProperty('--progress',`${pct*3.6}deg`);$('#progressLabel').textContent=activeRuns.length?'Sincronización en curso':'Estado de recursos';$('#progressDetail').textContent=total?`${fmt.format(done)} de ${fmt.format(total)} recursos resueltos`:'Sin recursos catalogados';$('#syncLabel').textContent=activeRuns.length?`Sincronizando ${activeRuns.map(r=>r.source_id).join(', ')}`:'Datos locales actualizados';const pills=$('#ingestStatus');pills.replaceChildren();for(const key of ['pending','parsed','downloaded','unsupported','failed'])if(status[key])pills.appendChild(el('span',`${key}: ${fmt.format(status[key])}`,`pill ${key}`))}
function renderRuns(runs){const box=$('#recentRuns');box.replaceChildren();if(!runs.length){box.appendChild(el('div','Sin actividad reciente.','empty-state'));return}for(const r of runs){const row=el('div',null,'activity-row');const info=el('div');info.append(el('b',r.source_id),el('small',`${r.status} · ${formatDate(r.finished_at||r.started_at)}`));row.append(info,el('span',fmt.format(r.records_written||0)));box.appendChild(row)}}

async function refresh(){const[dash,sources,geo]=await Promise.all([fetch('/api/dashboard').then(r=>r.json()),fetch('/api/sources').then(r=>r.json()),fetch('/api/map/features').then(r=>r.json())]);const t=dash.totals;$('#sources').textContent=fmt.format(t.sources);$('#datasets').textContent=fmt.format(t.datasets);$('#sourceRecords').textContent=fmt.format(t.sourceRecords);$('#metricCount').textContent=fmt.format(t.metrics);$('#observations').textContent=fmt.format(t.observations);$('#partiesCount').textContent=fmt.format(t.parties);$('#projectsCount').textContent=fmt.format(t.projects);$('#transactionsCount').textContent=fmt.format(t.transactions);$('#updatedAt').textContent=`Actualizado ${formatDate(dash.generatedAt)}`;renderSources(sources);renderEconomic(dash.economicSeries||[]);renderSpend(dash.spendByCategory||[]);renderProjects(dash.projectStatus||[]);renderChileCompra(dash.chileCompra||{});renderIngest(dash.resourceStatus||{},dash.activeRuns||[]);renderRuns(dash.recentRuns||[]);allFeatures=geo.features||[];renderMap($('#mapLayer').value)}
initMap();$('#mapLayer').addEventListener('change',e=>renderMap(e.target.value));refresh().catch(console.error);setInterval(()=>refresh().catch(console.error),10000);
