import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let sqlClient: NeonQueryFunction<false, false> | null = null;

export function hasProductionDatabase() {
  return (
    process.env.ARTICLE_REPOSITORY_DRIVER === "postgres" &&
    Boolean(process.env.DATABASE_URL)
  );
}

export function getDatabaseSql() {
  if (sqlClient) {
    return sqlClient;
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for integration persistence.");
  }

  sqlClient = neon(databaseUrl);
  return sqlClient;
}
