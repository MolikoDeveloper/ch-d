const fmt=new Intl.NumberFormat('es-CL');
const money=(n,c='CLP')=>n==null?'—':new Intl.NumberFormat('es-CL',{style:'currency',currency:c||'CLP',maximumFractionDigits:0}).format(n);
async function load(){
  const [summary,sources,transactions]=await Promise.all([
    fetch('/api/summary').then(r=>r.json()),fetch('/api/sources').then(r=>r.json()),fetch('/api/transactions?limit=30').then(r=>r.json())
  ]);
  sourcesEl.textContent=fmt.format(summary.sources); datasets.textContent=fmt.format(summary.catalogItems); resources.textContent=fmt.format(summary.resources); transactionsEl.textContent=fmt.format(summary.transactions);
  sourceCards.innerHTML=sources.slice(0,18).map(s=>`<div class="source-card"><b>${s.name}</b><small>${s.domain} · ${s.kinds.join(', ')}</small></div>`).join('');
  sourceFilter.innerHTML='<option value="">Todas</option>'+sources.map(s=>`<option value="${s.id}">${s.name}</option>`).join('');
  rows.innerHTML=transactions.length?transactions.map(t=>`<tr><td>${t.occurred_at?.slice(0,10)??'—'}</td><td>${t.transaction_type}</td><td>${t.title??t.external_id}</td><td>${t.source_id}</td><td>${money(t.amount,t.currency)}</td></tr>`).join(''):'<tr><td colspan="5">Sincroniza una fuente para comenzar.</td></tr>';
}
const sourcesEl=document.querySelector('#sources'),datasets=document.querySelector('#datasets'),resources=document.querySelector('#resources'),transactionsEl=document.querySelector('#transactions'),sourceCards=document.querySelector('#sourceCards'),sourceFilter=document.querySelector('#sourceFilter'),rows=document.querySelector('#rows');
load().catch(e=>{document.querySelector('#status').textContent='Error: '+e.message});
