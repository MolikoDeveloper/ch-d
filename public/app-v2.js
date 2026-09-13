const $=q=>document.querySelector(q);
const fmt=new Intl.NumberFormat('es-CL');
const compact=new Intl.NumberFormat('es-CL',{notation:'compact',maximumFractionDigits:1});
const money=n=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}).format(Number(n)||0);
let map,featureLayer,allFeatures=[];
let dashboardTimer=null,progressTimer=null;

function el(tag,text,cls){const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=String(text);return n}
function formatValue(v){if(v==null||v===''||Number.isNaN(Number(v)))return '—';const n=Number(v);return Number.isFinite(n)?new Intl.NumberFormat('es-CL',{maximumFractionDigits:3}).format(n):String(v)}
function formatDate(v){return v?new Date(v).toLocaleString('es-CL',{dateStyle:'medium',timeStyle:'short'}):'—'}

function initMap(){map=L.map('map',{zoomControl:true,preferCanvas:true,minZoom:3,maxZoom:18});L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);map.fitBounds([[-56.3,-76.8],[-17.2,-66.0]],{padding:[10,10]});featureLayer=L.layerGroup().addTo(map)}
function renderMap(kind='combined'){
  featureLayer.clearLayers();
  const areas=allFeatures.filter(f=>['Polygon','MultiPolygon'].includes(f.geometry?.type));
  const maxAmount=Math.max(1,...areas.map(f=>Number(f.properties?.transaction_amount)||0));
  for(const f of allFeatures){
    const p=f.properties||{},type=f.geometry?.type;
    if(type==='Polygon'||type==='MultiPolygon'){
      const amount=Number(p.transaction_amount)||0;
      const intensity=kind==='transaction'||kind==='combined'?amount/maxAmount:0;
      const layer=L.geoJSON(f,{style:{weight:1,fillOpacity:kind==='areas'?.12:.12+Math.min(.58,intensity*.58)}});
      layer.bindPopup(document.createTextNode(`${p.label||p.geo_name||'Región'} — ${fmt.format(p.transactions||0)} compras — ${money(amount)}`));
      layer.addTo(featureLayer);continue;
    }
    if(kind==='areas')continue;
    if(kind!=='combined'&&p.kind!==kind)continue;
    if(type!=='Point')continue;
    const [lon,lat]=f.geometry.coordinates;
    const marker=L.circleMarker([lat,lon],{radius:5,weight:1,color:'#fff',fillColor:'#1769e0',fillOpacity:.82});
    marker.bindPopup(document.createTextNode([p.label,p.geo_name,p.date?.slice?.(0,10),formatValue(p.value)].filter(Boolean).join(' — '))).addTo(featureLayer);
  }
}

function renderSources(sources){const select=$('#sourceFilter');select.replaceChildren(el('option','Todas'));select.firstChild.value='';for(const s of sources){const o=el('option',s.name);o.value=s.id;select.appendChild(o)}}
function renderEconomic(series){const box=$('#economicSeries');box.replaceChildren();if(!series.length){box.appendChild(el('div','Aún no hay indicadores clave disponibles.','empty-state'));return}for(const s of series){const row=el('div',null,'series-row');const info=el('div');info.append(el('b',s.label),el('small',`${s.metric} · ${s.frequency||'frecuencia desconocida'} · ${s.date?.slice?.(0,10)??'sin fecha'}`));row.append(info,el('strong',formatValue(s.value)));box.appendChild(row)}}
function renderChileCompra(data){$('#ccOrders').textContent=fmt.format(data.orders||0);$('#ccAmount').textContent=money(data.amount||0);$('#ccBuyers').textContent=fmt.format(data.buyers||0);$('#ccSuppliers').textContent=fmt.format(data.suppliers||0);const box=$('#ccRegions');box.replaceChildren();if(!data.byRegion?.length){box.appendChild(el('div','Sin compras georreferenciadas todavía.','empty-state'));return}const max=Math.max(...data.byRegion.map(x=>Number(x.amount)||0),1);for(const x of data.byRegion){const row=el('div',null,'bar-row');row.append(el('span',x.region||'Sin región'));const track=el('div',null,'bar-track'),fill=el('i',null,'bar-fill');fill.style.width=`${Math.max(3,(Number(x.amount)||0)/max*100)}%`;track.appendChild(fill);row.append(track,el('b',compact.format(Number(x.amount)||0)));box.appendChild(row)}}
function renderCoverage(items){const box=$('#sourceCoverage');box.replaceChildren();for(const x of items||[]){const row=el('div',null,'coverage-row');const dot=el('span','',`coverage-dot ${x.active?'active':'idle'}`);const info=el('div');info.append(el('b',x.name),el('small',`${x.domain} · ${x.detail}`));row.append(dot,info,el('strong',compact.format(Number(x.records)||0)));box.appendChild(row)}if(!box.children.length)box.appendChild(el('div','Todavía no hay fuentes pobladas.','empty-state'))}
function renderConnectorProgress(items){const box=$('#connectorProgress');box.replaceChildren();for(const x of items||[]){const current=Number(x.current)||0,total=x.total==null?null:Number(x.total)||0,pct=total?Math.min(100,current/total*100):null;const row=el('div',null,'connector-row');const head=el('div',null,'connector-head');const left=el('div');left.append(el('b',x.name),el('small',x.run?.message||`${fmt.format(current)} ${x.unit}`));head.append(left,el('span',total?`${fmt.format(current)} / ${fmt.format(total)}`:fmt.format(current)));row.append(head);if(total){const track=el('div',null,'connector-track'),fill=el('i',null,'connector-fill');fill.style.width=`${pct}%`;track.appendChild(fill);row.append(track)}box.appendChild(row)}if(!box.children.length)box.appendChild(el('div','Sin conectores activos.','empty-state'))}
function renderRuns(runs){const box=$('#recentRuns');box.replaceChildren();if(!runs.length){box.appendChild(el('div','Sin actividad reciente.','empty-state'));return}for(const r of runs){const row=el('div',null,'activity-row');const info=el('div');const detail=[r.status,r.message,formatDate(r.finished_at||r.started_at)].filter(Boolean).join(' · ');info.append(el('b',r.source_id),el('small',detail));row.append(info,el('span',compact.format(Number(r.records_written)||0)));box.appendChild(row)}}

async function loadDashboard(){if(document.hidden)return;const dash=await fetch('/api/dashboard').then(r=>r.json());const t=dash.totals;$('#sources').textContent=fmt.format(t.sources);$('#populatedSources').textContent=`${fmt.format(t.populatedSources||0)} con datos`;$('#datasets').textContent=fmt.format(t.datasets);$('#sourceRecords').textContent=fmt.format(t.sourceRecords);$('#metricCount').textContent=fmt.format(t.metrics);$('#observations').textContent=fmt.format(t.observations);$('#updatedAt').textContent=`Actualizado ${formatDate(dash.generatedAt)}`;renderEconomic(dash.economicSeries||[]);renderChileCompra(dash.chileCompra||{});renderCoverage(dash.sourceCoverage||[])}
async function loadProgress(){if(document.hidden)return;const p=await fetch('/api/progress').then(r=>r.json());$('#syncLabel').textContent=p.activeRuns?.length?`Sincronizando ${p.activeRuns.map(r=>r.source_id).join(', ')}`:'Datos locales actualizados';renderConnectorProgress(p.connectorProgress||[]);renderRuns(p.recentRuns||[])}
async function loadMap(){const geo=await fetch('/api/map/features').then(r=>r.json());allFeatures=geo.features||[];renderMap($('#mapLayer').value)}
async function initialLoad(){const[sources]=await Promise.all([fetch('/api/sources').then(r=>r.json()),loadDashboard(),loadProgress(),loadMap()]);renderSources(sources)}
function startTimers(){stopTimers();dashboardTimer=setInterval(()=>loadDashboard().catch(console.error),60000);progressTimer=setInterval(()=>loadProgress().catch(console.error),5000)}
function stopTimers(){if(dashboardTimer)clearInterval(dashboardTimer);if(progressTimer)clearInterval(progressTimer);dashboardTimer=progressTimer=null}

initMap();
$('#mapLayer').addEventListener('change',e=>renderMap(e.target.value));
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopTimers();else{loadDashboard().catch(console.error);loadProgress().catch(console.error);startTimers()}});
initialLoad().then(startTimers).catch(console.error);
