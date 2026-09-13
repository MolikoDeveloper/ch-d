const fmt = new Intl.NumberFormat('es-CL');
const money = (n, c = 'CLP') => n == null ? '—' : new Intl.NumberFormat('es-CL', { style: 'currency', currency: c || 'CLP', maximumFractionDigits: 0 }).format(n);
const $ = (q) => document.querySelector(q);

let map;
let featureLayer;
let allFeatures = [];

function initMap() {
  map = L.map('map', { zoomControl: true, preferCanvas: true, minZoom: 3, maxZoom: 18 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);
  map.fitBounds([[-56.3, -76.8], [-17.2, -66.0]], { padding: [10, 10] });
  featureLayer = L.layerGroup().addTo(map);
}

function popupText(p) {
  const parts = [p.label ?? p.kind, p.geo_name ?? '', p.date?.slice?.(0, 10) ?? ''];
  if (p.value != null) parts.push(`${fmt.format(p.value)} ${p.unit ?? ''}`);
  return parts.filter(Boolean).join(' — ');
}

function renderMap(kind = 'combined') {
  featureLayer.clearLayers();
  const features = allFeatures.filter((f) => kind === 'combined' || f.properties.kind === kind);
  for (const f of features) {
    if (!f.geometry || f.geometry.type !== 'Point') continue;
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties;
    const color = p.kind === 'transaction' ? '#1769e0' : '#d93045';
    L.circleMarker([lat, lon], { radius: 6, weight: 1, color: '#fff', fillColor: color, fillOpacity: 0.85 })
      .bindPopup(document.createTextNode(popupText(p)))
      .addTo(featureLayer);
  }
}

function appendTextElement(parent, tag, text, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function renderSources(sources) {
  const cards = $('#sourceCards');
  cards.replaceChildren();
  for (const s of sources.slice(0, 18)) {
    const card = document.createElement('div');
    card.className = 'source-card';
    appendTextElement(card, 'b', s.name);
    appendTextElement(card, 'small', `${s.domain} · ${s.kinds.join(', ')}`);
    cards.appendChild(card);
  }

  const select = $('#sourceFilter');
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Todas';
  select.appendChild(all);
  for (const s of sources) {
    const option = document.createElement('option');
    option.value = s.id;
    option.textContent = s.name;
    select.appendChild(option);
  }
}

function renderTransactions(transactions) {
  const tbody = $('#rows');
  tbody.replaceChildren();
  if (!transactions.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = 'Aún no hay transacciones normalizadas; los registros crudos pueden estar ya descargados.';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }
  for (const t of transactions) {
    const row = document.createElement('tr');
    for (const value of [t.occurred_at?.slice(0, 10) ?? '—', t.transaction_type, t.title ?? t.external_id, t.source_id, money(t.amount, t.currency)]) {
      appendTextElement(row, 'td', String(value ?? '—'));
    }
    tbody.appendChild(row);
  }
}

function renderStatus(statuses) {
  const container = $('#ingestStatus');
  container.replaceChildren();
  let found = false;
  for (const key of ['pending', 'parsed', 'downloaded', 'unsupported', 'failed']) {
    if (!statuses[key]) continue;
    found = true;
    appendTextElement(container, 'span', `${key}: ${fmt.format(statuses[key])}`, `pill ${key}`);
  }
  if (!found) appendTextElement(container, 'span', 'sin estado', 'pill');
}

async function load() {
  const [summary, sources, transactions, geo] = await Promise.all([
    fetch('/api/summary').then((r) => r.json()),
    fetch('/api/sources').then((r) => r.json()),
    fetch('/api/transactions?limit=30').then((r) => r.json()),
    fetch('/api/map/features').then((r) => r.json())
  ]);
  $('#sources').textContent = fmt.format(summary.sources);
  $('#datasets').textContent = fmt.format(summary.catalogItems);
  $('#resources').textContent = fmt.format(summary.resources);
  $('#sourceRecords').textContent = fmt.format(summary.sourceRecords);
  renderSources(sources);
  renderTransactions(transactions);
  renderStatus(summary.resourceStatus || {});
  allFeatures = geo.features || [];
  renderMap($('#mapLayer').value);
}

initMap();
$('#mapLayer').addEventListener('change', (e) => renderMap(e.target.value));
load().catch((e) => {
  $('#status').textContent = `Error: ${e.message}`;
  console.error(e);
});
