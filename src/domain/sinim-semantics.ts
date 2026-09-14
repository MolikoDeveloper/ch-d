function normalized(value:string){
  return String(value??"")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g," ")
    .trim();
}

const REGION_HEADINGS=new Set([
  "arica y parinacota","tarapaca","antofagasta","atacama","coquimbo","valparaiso",
  "metropolitana","metropolitana de santiago","del libertador gral bernardo o higgins",
  "del libertador general bernardo o higgins","del maule","nuble","del biobio","biobio",
  "de la araucania","la araucania","los rios","de los lagos","los lagos",
  "aysen del general carlos ibanez del campo","aysen","magallanes y de la antartica chilena",
]);

export function cleanSinimTitle(value:string){
  return String(value??"")
    .replace(/\s*\((?:[^)]*(?:indicador\s+disponible|datos?\s+desde|disponible\s+(?:a\s+partir|desde)|serie\s+disponible)[^)]*)\)\s*/gi," ")
    .replace(/\s+/g," ")
    .trim();
}

export function cleanSinimSection(value:string){
  return String(value??"")
    .replace(/\b20\d{2}\b/g,"")
    .replace(/\(\s*Fuente[^)]*\)/gi,"")
    .replace(/\s+/g," ")
    .replace(/\s+\)/g,")")
    .replace(/\s*:\s*$/g,"")
    .trim();
}

export function sinimCategory(titleRaw:string,sectionRaw:string){
  const title=normalized(cleanSinimTitle(titleRaw));
  const section=normalized(cleanSinimSection(sectionRaw));

  if(/\b(superficie|poblacion)\b/.test(title))return "Población y territorio";
  if(/\b(casen|pobreza|vulnerabilidad)\b/.test(title)||/\bcasen\b/.test(section))return "Situación social";
  if(/\b(educacion|paes|establecimientos de educacion)\b/.test(title)||/\beducacion\b/.test(section))return "Educación";
  if(/\b(salud|consultorios|postas)\b/.test(title)||/\bsalud\b/.test(section))return "Salud";
  if(/\b(funcionarios|personal|honorarios|contrata|planta|profesionalizacion|grado del alcalde)\b/.test(title)||/\brrhh\b/.test(section))return "Personal municipal";
  if(/\b(predios|propiedades|pladeco|gestion territorial)\b/.test(title)||/\bdesarrollo y gestion territorial\b/.test(section))return "Gestión territorial";
  if(/\b(transferencia|compensacion|figem|premir|prbipe|ptrac|pmu|pmb|sifim|revitalizacion|tenencia responsable)\b/.test(title)||/\btransferencias? y compensaciones\b/.test(section))return "Transferencias SUBDERE";
  if(/\b(ingreso|gasto|fondo comun|fcm|impuesto|patente|permiso de circulacion|casino|consumo de agua|consumo de electricidad)\b/.test(title)||/\b(ingresos municipales|gastos municipales|fondo comun municipal)\b/.test(section))return "Finanzas municipales";

  if(!section||REGION_HEADINGS.has(section)||/^superficie comunal/.test(section))return "Otros datos municipales";
  return cleanSinimSection(sectionRaw);
}

export function sinimMetricKey(titleRaw:string){
  return normalized(cleanSinimTitle(titleRaw));
}
