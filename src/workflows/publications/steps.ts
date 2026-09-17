import {
  discoverPublication,
  syncPublicationEntry,
} from "@/server/publications/sync";
import { getDatabaseSql } from "@/server/database";
import type {
  PublicationEntry,
  PublicationSource,
} from "@/server/publications/sources";
import { publicationSources } from "@/server/publications/sources";
export async function subscribedSources(owner: string) {
  "use step";
  const subscriptions = await getDatabaseSql().query(
    "SELECT source FROM publication_subscriptions WHERE owner_email=$1 ORDER BY source",
    [owner],
  );
  return subscriptions
    .map((row) => String(row.source))
    .filter((source): source is PublicationSource =>
      Object.hasOwn(publicationSources, source),
    );
}
export async function discover(source: PublicationSource) {
  "use step";
  return discoverPublication(source);
}
export async function importEntry(
  owner: string,
  source: PublicationSource,
  entry: PublicationEntry,
) {
  "use step";
  return syncPublicationEntry(owner, source, entry);
}
export async function finish(
  owner: string,
  source: PublicationSource,
  errors: string[],
) {
  "use step";
  await getDatabaseSql().query(
    "UPDATE publication_subscriptions SET last_checked_at=now(),last_error=$3 WHERE owner_email=$1 AND source=$2",
    [owner, source, errors.length ? errors.join("\n").slice(0, 4000) : null],
  );
}
