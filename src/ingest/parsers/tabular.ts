import Papa from "papaparse";
import * as XLSX from "xlsx";

export type ParsedRecord = Record<string, unknown>;

export function parseCsv(text:string):ParsedRecord[]{
  const result=Papa.parse<Record<string,unknown>>(text,{header:true,skipEmptyLines:true,dynamicTyping:false});
  if(result.errors.length && !result.data.length) throw new Error(`CSV inválido: ${result.errors[0]?.message}`);
  return result.data;
}

export function parseJson(text:string):ParsedRecord[]{
  const value=JSON.parse(text);
  if(Array.isArray(value)) return value.map((v,i)=>typeof v==="object"&&v!==null?v:{value:v,index:i}) as ParsedRecord[];
  if(value && typeof value==="object"){
    const candidates=[(value as any).records,(value as any).result?.records,(value as any).data,(value as any).items,(value as any).Listado];
    const arr=candidates.find(Array.isArray);
    if(arr) return arr.map((v:any,i:number)=>typeof v==="object"&&v!==null?v:{value:v,index:i});
    return [value as ParsedRecord];
  }
  return [{value}];
}

export function parseXlsx(bytes:Uint8Array):ParsedRecord[]{
  const wb=XLSX.read(bytes,{type:"array",cellDates:false,raw:false});
  const rows:ParsedRecord[]=[];
  for(const sheetName of wb.SheetNames){
    const sheet=wb.Sheets[sheetName];
    const sheetRows=XLSX.utils.sheet_to_json<ParsedRecord>(sheet,{defval:null,raw:false});
    for(const row of sheetRows) rows.push({__sheet:sheetName,...row});
  }
  return rows;
}

export function parseResource(format:string,bytes:Uint8Array,text:string):ParsedRecord[]{
  const f=format.toUpperCase();
  if(f.includes("CSV")||f==="TXT") return parseCsv(text);
  if(f.includes("JSON")||f==="GEOJSON") return parseJson(text);
  if(f.includes("XLS")||f.includes("EXCEL")) return parseXlsx(bytes);
  throw new Error(`Formato tabular todavía no soportado: ${format}`);
}
