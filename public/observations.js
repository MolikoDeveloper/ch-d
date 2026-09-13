const $=q=>document.querySelector(q);
const fmt=new Intl.NumberFormat('es-CL');
async function load(){
  const metrics=await fetch('/api/metrics?source=bcentral&limit=5000').then(r=>r.json());
  const obs=await fetch('/api/observations?source=bcentral&limit=250').then(r=>r.json());
  $('#metricCount').textContent=fmt.format(metrics.length);
  $('#observations').textContent=fmt.format(obs.length);
  const s=$('#metricFilter');
  for(const m of metrics){const o=document.createElement('option');o.value=m.metric;o.textContent=m.metric;s.appendChild(o)}
  const b=$('#observationRows');b.replaceChildren();
  for(const x of obs){const r=document.createElement('tr');for(const v of [x.observed_at?.slice(0,10)||'—',x.source_id,x.metric,x.value_number??x.value_text??'—',x.unit||'—']){const c=document.createElement('td');c.textContent=String(v);r.appendChild(c)}b.appendChild(r)}
  $('#latestObservation').textContent=obs[0]?.observed_at?.slice(0,10)||'—';
}
load().catch(console.error);
