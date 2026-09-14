export type SinimObservation={section:string;title:string;unit:string|null;valueNumber:number|null;valueText:string|null};
export type SinimAuthority={role:"mayor"|"councillor";name:string;party:string|null};

function decodeHtml(s:string){return s.replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&deg;/gi,"°").replace(/&sup2;/gi,"²").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)))}
export function htmlText(html:string){return decodeHtml(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim())}
function numeric(v:string){const s=v.trim().replace(/\s/g,"").replace(/\.(?=\d{3}(?:\D|$))/g,"").replace(",",".").replace(/%$/,"");if(!s||/^(?:n\/?a|s\/?d|sin dato|sin dato oficial|no aplica|no recepcionado|descontinuado|-+)$/i.test(s))return null;const n=Number(s);return Number.isFinite(n)?n:null}
function sectionAt(headings:Array<{at:number,name:string}>,at:number){let section="Ficha comunal";for(const h of headings){if(h.at>at)break;if(h.name)section=h.name}return section}

export function parseSinimProfile(html:string){
  const year=Number(html.match(/año\s+(20\d{2})/i)?.[1]??new Date().getFullYear());
  const headings:Array<{at:number,name:string}>=[];
  for(const m of html.matchAll(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/gi)) headings.push({at:m.index??0,name:htmlText(m[1])});
  const observations:SinimObservation[]=[];const seen=new Set<string>();
  const add=(at:number,titleRaw:string,unitRaw:string|null,valueRaw:string)=>{
    const title=htmlText(titleRaw),unit=unitRaw?htmlText(unitRaw)||null:null,value=htmlText(valueRaw);
    if(!title||!value||/^(informaci[oó]n|dato|descripci[oó]n|unidad medida)$/i.test(title)||/^(comunal|municipal|nacional)$/i.test(value))return;
    const section=sectionAt(headings,at),key=`${section}|${title}|${value}`;if(seen.has(key))return;seen.add(key);
    const n=numeric(value);observations.push({section,title,unit,valueNumber:n,valueText:n==null?value:null});
  };

  for(const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)){
    for(const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
      const cells=[...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c=>c[1]);
      if(cells.length>=3)add(table.index??0,cells[0],cells[1],cells[2]);
    }
  }

  const divRow=/<div\s+class=["'][^"']*col_info_tit[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<div\s+class=["'][^"']*col_info_medida[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<div\s+class=["'][^"']*col_info_comunal[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  for(const row of html.matchAll(divRow)) add(row.index??0,row[1],row[2],row[3]);

  const highlighted=/<h4[^>]*>([^<:]+):?\s*<\/h4>\s*<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  for(const row of html.matchAll(highlighted)) add(row.index??0,row[1],null,row[2]);

  const authorities:SinimAuthority[]=[];
  const mayor=html.match(/<div\s+class=["']nombre_alcalde["'][^>]*>[\s\S]*?<h4[^>]*>Alcalde[^<]*<\/h4>\s*<h3[^>]*>([\s\S]*?)<\/h3>\s*<h4[^>]*>([\s\S]*?)<\/h4>/i);
  if(mayor){const name=htmlText(mayor[1]),party=htmlText(mayor[2]);if(name)authorities.push({role:"mayor",name,party:party||null})}
  for(const row of html.matchAll(/<div\s+class=["']col_nom["'][^>]*>([\s\S]*?)<\/div>\s*<div\s+class=["']col_partido["'][^>]*>([\s\S]*?)<\/div>/gi)){
    const name=htmlText(row[1]),party=htmlText(row[2]);if(name&&!/concejo municipal/i.test(name))authorities.push({role:"councillor",name,party:party||null});
  }
  return{year,observations,authorities};
}
