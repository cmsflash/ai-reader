import { PostgresDiscussionRepository } from "@/server/adapters/postgresDiscussionRepository";
import { hasProductionDatabase } from "@/server/database";
import {
  DiscussionPersistenceError,
  type DiscussionRepository,
} from "@/server/ports/discussionRepository";

let repository: DiscussionRepository | null = null;

export function getDiscussionRepository(): DiscussionRepository {
  if (!hasProductionDatabase()) {
    throw new DiscussionPersistenceError();
  }

  repository ??= new PostgresDiscussionRepository();
  return repository;
}
