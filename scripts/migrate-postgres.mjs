import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { loadLocalEnv } from "./lib/env.mjs";

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required. Pull or set production env vars first.");
  process.exit(1);
}

const migrationsDir = path.join(process.cwd(), "migrations");
const sql = neon(databaseUrl);
const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

for (const file of files) {
  const migration = await readFile(path.join(migrationsDir, file), "utf8");
  process.stdout.write(`Applying ${file}... `);
  for (const statement of splitStatements(migration)) {
    await sql.query(statement);
  }
  process.stdout.write("done\n");
}

function splitStatements(sqlText) {
  return sqlText
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}
