import { PostgresNarrationPolicyRepository } from "@/server/adapters/postgresNarrationPolicyRepository";
import { hasProductionDatabase } from "@/server/database";
import {
  NarrationPolicyPersistenceError,
  type NarrationPolicyRepository,
} from "@/server/ports/narrationPolicyRepository";

let repository: NarrationPolicyRepository | null = null;

export function getNarrationPolicyRepository(): NarrationPolicyRepository {
  if (!hasProductionDatabase()) {
    throw new NarrationPolicyPersistenceError();
  }

  repository ??= new PostgresNarrationPolicyRepository();
  return repository;
}
