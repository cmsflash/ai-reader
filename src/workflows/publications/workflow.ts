import { discover, importEntry, finish } from "./steps";
import type { PublicationSource } from "@/server/publications/sources";
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
