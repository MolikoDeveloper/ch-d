import Papa from "papaparse";
import * as XLSX from "xlsx";
import { XMLParser } from "fast-xml-parser";
import { unzipSync, strFromU8 } from "fflate";

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
    const candidates=[(value as any).features,(value as any).records,(value as any).result?.records,(value as any).data,(value as any).items,(value as any).Listado];
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

function arrays(value:unknown,path="root",out:Array<{path:string;value:unknown[]}>=[]){
  if(Array.isArray(value)){ out.push({path,value}); return out; }
  if(value && typeof value==="object") for(const [k,v] of Object.entries(value as Record<string,unknown>)) arrays(v,`${path}.${k}`,out);
  return out;
}
export function parseXml(text:string):ParsedRecord[]{
  const value=new XMLParser({ignoreAttributes:false,attributeNamePrefix:"@_"}).parse(text);
  const candidates=arrays(value).sort((a,b)=>b.value.length-a.value.length);
  if(candidates[0]?.value.length) return candidates[0].value.map((v,i)=>typeof v==="object"&&v!==null?{__xml_path:candidates[0].path,...v as Record<string,unknown>}:{__xml_path:candidates[0].path,value:v,index:i});
  return [value as ParsedRecord];
}

function inferredFormat(name:string){
  const n=name.toLowerCase();
  if(n.endsWith('.csv')||n.endsWith('.tsv')||n.endsWith('.txt')) return 'CSV';
  if(n.endsWith('.json')||n.endsWith('.geojson')) return 'JSON';
  if(n.endsWith('.xlsx')||n.endsWith('.xls')) return 'XLSX';
  if(n.endsWith('.xml')) return 'XML';
  return '';
}
export function parseZip(bytes:Uint8Array):ParsedRecord[]{
  const files=unzipSync(bytes); const rows:ParsedRecord[]=[];
  for(const [name,data] of Object.entries(files)){
    const format=inferredFormat(name); if(!format) continue;
    try{
      const parsed=parseResource(format,data,format==='XLSX'?'':strFromU8(data));
      for(const row of parsed) rows.push({__archive_file:name,...row});
    }catch(e){ rows.push({__archive_file:name,__parse_error:String(e)}); }
  }
  if(!rows.length) throw new Error('ZIP sin archivos tabulares soportados');
  return rows;
}

export function parseResource(format:string,bytes:Uint8Array,text:string):ParsedRecord[]{
  const f=format.toUpperCase();
  if(f.includes("CSV")||f.includes("TSV")||f==="TXT") return parseCsv(text);
  if(f.includes("JSON")||f.includes("GEOJSON")) return parseJson(text);
  if(f.includes("XLS")||f.includes("EXCEL")) return parseXlsx(bytes);
  if(f.includes("XML")) return parseXml(text);
  if(f.includes("ZIP")) return parseZip(bytes);
  throw new Error(`Formato tabular todavía no soportado: ${format}`);
}

export function isParseableFormat(format:string,url=""){
  const f=(format||inferredFormat(url)).toUpperCase();
  return ["CSV","TSV","TXT","JSON","GEOJSON","XLS","XLSX","EXCEL","XML","ZIP"].some(x=>f.includes(x));
}
