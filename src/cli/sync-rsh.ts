import { initDb } from "../db";
import { syncRsh } from "../ingest/connectors/rsh";

await initDb();
console.log(await syncRsh());
