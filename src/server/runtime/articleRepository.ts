import { LocalJsonArticleRepository } from "@/server/adapters/localJsonArticleRepository";
import { PostgresArticleRepository } from "@/server/adapters/postgresArticleRepository";
import type { ArticleRepository } from "@/server/ports/articleRepository";

type ArticleRepositoryDriver = "local-json" | "firebase" | "supabase" | "postgres";

let repository: ArticleRepository | null = null;

export function getArticleRepository(): ArticleRepository {
  if (repository) {
    return repository;
  }

  const driver = getDriver();

  switch (driver) {
    case "local-json":
      repository = new LocalJsonArticleRepository();
      return repository;
    case "postgres":
      repository = new PostgresArticleRepository();
      return repository;
    case "firebase":
    case "supabase":
      throw new Error(
        `ARTICLE_REPOSITORY_DRIVER=${driver} is configured, but its adapter is not implemented yet.`,
      );
    default:
      driver satisfies never;
      throw new Error("Unsupported article repository driver.");
  }
}

function getDriver(): ArticleRepositoryDriver {
  const driver = process.env.ARTICLE_REPOSITORY_DRIVER ?? "local-json";

  if (driver === "local-json" || driver === "firebase" || driver === "supabase" || driver === "postgres") {
    return driver;
  }

  throw new Error(`Unsupported ARTICLE_REPOSITORY_DRIVER=${driver}`);
}
