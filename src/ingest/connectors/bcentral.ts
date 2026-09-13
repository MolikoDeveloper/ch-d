import { finishRun, startRun } from "../../db";

// La API BDE requiere una cuenta habilitada y API Key. El catálogo de series cambia;
// las series a sincronizar se declaran en data/bcentral-series.json para evitar hardcodear indicadores.
export async function syncBCentral(){
  const apiKey=process.env.BCCH_API_KEY;
  const email=process.env.BCCH_USER_EMAIL;
  if(!apiKey || !email) throw new Error("Faltan BCCH_API_KEY y/o BCCH_USER_EMAIL en .env");
  const run=startRun("bcentral");
  try{
    const cfgFile=Bun.file("data/bcentral-series.json");
    if(!(await cfgFile.exists())){
      await Bun.write("data/bcentral-series.json",JSON.stringify({series:[]},null,2));
      finishRun(run,"success","No hay series configuradas; se creó data/bcentral-series.json",0,0);
      return {seen:0,written:0};
    }
    const cfg=await cfgFile.json() as {series:Array<{id:string;name?:string}>};
    // Intencionalmente no se inventa un endpoint: las credenciales/API BDE deben validarse
    // contra la documentación vigente antes de habilitar descarga de series.
    finishRun(run,"success",`Credenciales presentes. ${cfg.series.length} series configuradas. Adaptador REST pendiente de endpoint validado.`,cfg.series.length,0);
    return {seen:cfg.series.length,written:0};
  }catch(e){ finishRun(run,"failed",String(e),0,0); throw e; }
}
