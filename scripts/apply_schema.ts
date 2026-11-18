// Apply the additive `split` schema to the shared Neon DB. Idempotent — safe to
// run repeatedly and safe against the live attribution DB (creates only split.*).
//   npm run schema
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { ensureSchema, getPool } from "../lib/db";

(async () => {
  await ensureSchema();
  const { rows } = await getPool().query(
    `select table_name from information_schema.tables where table_schema = 'split' order by table_name`
  );
  console.log("split schema applied. tables:", rows.map((r) => r.table_name).join(", "));
  await getPool().end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
