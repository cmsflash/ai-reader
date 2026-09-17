import { discover, importEntry, finish, subscribedSources } from "./steps";
import type { PublicationSource } from "@/server/publications/sources";
export async function syncSubscribedPublications(owner: string) {
  "use workflow";
  const sources = await subscribedSources(owner);
  const results = [];
  // One durable run per reader processes every source in turn, avoiding competing
  // article writes while keeping a source failure from skipping the others.
  for (const source of sources) {
    results.push({ source, ...await syncPublication(owner, source) });
  }
  return results;
}
export async function syncPublication(
  owner: string,
  source: PublicationSource,
) {
  "use workflow";
  const errors: string[] = [];
  const outcomes: string[] = [];
  try {
    const entries = await discover(source);
    for (const entry of entries) {
      try {
        outcomes.push(await importEntry(owner, source, entry));
      } catch (error) {
        errors.push(
          `${entry.url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  await finish(owner, source, errors);
  return { outcomes, errors };
}
