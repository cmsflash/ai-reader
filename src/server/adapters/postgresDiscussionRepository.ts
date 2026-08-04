import { randomUUID } from "node:crypto";
import {
  MAX_DISCUSSION_HISTORY_CHARACTERS,
  MAX_DISCUSSION_HISTORY_ITEM_CHARACTERS,
  MAX_DISCUSSION_HISTORY_ITEMS,
  type DiscussionHistoryItem,
  type DiscussionScope,
} from "@/server/ai/articleDiscussion";
import { getDatabaseSql } from "@/server/database";
import {
  DiscussionPersistenceError,
  type ClaimDiscussionTurnInput,
  type ClaimDiscussionTurnResult,
  type CompleteDiscussionAssistantInput,
  type DiscussionFailureCode,
  type DiscussionMessageRole,
  type DiscussionMessageStatus,
  type DiscussionRepository,
  type StoredDiscussionMessage,
} from "@/server/ports/discussionRepository";

type QueryClient = {
  query(statement: string, params?: unknown[]): Promise<unknown[]>;
};

type DiscussionMessageRow = {
  sequence: number | string;
  id: string;
  request_id: string;
  role: DiscussionMessageRole;
  status: DiscussionMessageStatus;
  content: string;
  scope: DiscussionScope | null;
  selection_text: string | null;
  attempt_id: string | null;
  response_id: string | null;
  model: string | null;
  incomplete: boolean | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  total_tokens: number | string | null;
  context_scope: DiscussionScope | null;
  context_truncated: boolean | null;
  context_original_characters: number | string | null;
  context_included_characters: number | string | null;
  context_note: string | null;
  error_code: DiscussionFailureCode | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type HistoryRow = {
  sequence: number | string;
  role: "user" | "assistant";
  content: string;
};

const maxResumeMessages = 200;
const attemptLeaseMilliseconds = 120_000;
export class PostgresDiscussionRepository implements DiscussionRepository {
  private readonly queryClient?: QueryClient;

  constructor(queryClient?: QueryClient) {
    this.queryClient = queryClient;
  }

  async claimTurn(
    input: ClaimDiscussionTurnInput,
  ): Promise<ClaimDiscussionTurnResult> {
    const ownerEmail = normalizeOwnerEmail(input.ownerEmail);
    const now = new Date();
    const nowIso = now.toISOString();
    const userRows = await this.queryRows<DiscussionMessageRow>(
      `
        INSERT INTO article_discussion_messages (
          id,
          owner_email,
          article_id,
          request_id,
          role,
          status,
          content,
          scope,
          selection_text,
          created_at,
          updated_at
        )
        SELECT
          $1,
          $2,
          article.id,
          $4,
          'user',
          'complete',
          $5,
          $6,
          $7::text,
          $8::timestamptz,
          $8::timestamptz
        FROM articles AS article
        WHERE article.owner_email = $2 AND article.id = $3
        ON CONFLICT (owner_email, article_id, request_id, role) DO NOTHING
        RETURNING ${messageColumns}
      `,
      [
        `discussion-message-${randomUUID()}`,
        ownerEmail,
        input.articleId,
        input.requestId,
        input.message,
        input.scope,
        input.selection ?? null,
        nowIso,
      ],
    );

    const user =
      (userRows[0] ? rowToStoredMessage(userRows[0]) : null) ??
      (await this.findTurnMessage(
        ownerEmail,
        input.articleId,
        input.requestId,
        "user",
      ));

    if (!user) {
      return { kind: "missing-article" };
    }

    if (
      user.content !== input.message ||
      user.scope !== input.scope ||
      (user.selection ?? undefined) !== (input.selection ?? undefined)
    ) {
      return { kind: "conflict" };
    }

    const attemptId = `discussion-attempt-${randomUUID()}`;
    const assistantRows = await this.queryRows<DiscussionMessageRow>(
      `
        INSERT INTO article_discussion_messages (
          id,
          owner_email,
          article_id,
          request_id,
          role,
          status,
          content,
          attempt_id,
          model,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          'assistant',
          'pending',
          '',
          $5,
          $6,
          $7::timestamptz,
          $7::timestamptz
        )
        ON CONFLICT (owner_email, article_id, request_id, role) DO UPDATE
        SET
          status = 'error',
          attempt_id = NULL,
          error_code = 'internal',
          updated_at = EXCLUDED.updated_at
        WHERE
          article_discussion_messages.status = 'pending'
          AND article_discussion_messages.updated_at < now() - INTERVAL '2 minutes'
        RETURNING ${messageColumns}
      `,
      [
        `discussion-message-${randomUUID()}`,
        ownerEmail,
        input.articleId,
        input.requestId,
        attemptId,
        input.model,
        nowIso,
      ],
    );

    if (assistantRows[0]) {
      const assistant = rowToStoredMessage(assistantRows[0]);

      if (assistant.status !== "pending") {
        return {
          kind: "existing",
          user,
          assistant,
        };
      }

      return {
        kind: "claimed",
        user,
        assistant,
        attemptId,
      };
    }

    const assistant = await this.findTurnMessage(
      ownerEmail,
      input.articleId,
      input.requestId,
      "assistant",
    );

    if (!assistant) {
      throw new DiscussionPersistenceError();
    }

    return {
      kind: "existing",
      user,
      assistant,
    };
  }

  async completeAssistant(input: CompleteDiscussionAssistantInput) {
    const usage = input.usage;
    const rows = await this.queryRows<DiscussionMessageRow>(
      `
        UPDATE article_discussion_messages
        SET
          status = 'complete',
          content = $5,
          attempt_id = NULL,
          response_id = $6::text,
          model = $7,
          incomplete = $8,
          input_tokens = $9::integer,
          output_tokens = $10::integer,
          total_tokens = $11::integer,
          context_scope = $12,
          context_truncated = $13,
          context_original_characters = $14,
          context_included_characters = $15,
          context_note = $16::text,
          error_code = NULL,
          updated_at = $17::timestamptz
        WHERE
          owner_email = $1
          AND article_id = $2
          AND request_id = $3
          AND role = 'assistant'
          AND status = 'pending'
          AND attempt_id = $4
        RETURNING ${messageColumns}
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        input.articleId,
        input.requestId,
        input.attemptId,
        input.reply,
        input.responseId ?? null,
        input.model,
        input.incomplete,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.totalTokens ?? null,
        input.context.scope,
        input.context.truncated,
        input.context.originalCharacters,
        input.context.includedCharacters,
        input.context.note ?? null,
        new Date().toISOString(),
      ],
    );

    return rows[0] ? rowToStoredMessage(rows[0]) : null;
  }

  async failAssistant(input: {
    ownerEmail: string;
    articleId: string;
    requestId: string;
    attemptId: string;
    errorCode: DiscussionFailureCode;
  }) {
    const rows = await this.queryRows<DiscussionMessageRow>(
      `
        UPDATE article_discussion_messages
        SET
          status = 'error',
          content = '',
          attempt_id = NULL,
          error_code = $5,
          updated_at = $6::timestamptz
        WHERE
          owner_email = $1
          AND article_id = $2
          AND request_id = $3
          AND role = 'assistant'
          AND status = 'pending'
          AND attempt_id = $4
        RETURNING ${messageColumns}
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        input.articleId,
        input.requestId,
        input.attemptId,
        input.errorCode,
        new Date().toISOString(),
      ],
    );

    return rows[0] ? rowToStoredMessage(rows[0]) : null;
  }

  async listArticleMessages(ownerEmail: string, articleId: string) {
    const rows = await this.queryRows<DiscussionMessageRow>(
      `
        SELECT ${messageColumns}
        FROM (
          SELECT ${messageColumns}
          FROM article_discussion_messages
          WHERE owner_email = $1 AND article_id = $2
          ORDER BY sequence DESC
          LIMIT $3
        ) AS recent_messages
        ORDER BY sequence
      `,
      [normalizeOwnerEmail(ownerEmail), articleId, maxResumeMessages + 1],
    );
    const hasMore = rows.length > maxResumeMessages;
    const visibleRows = hasMore ? rows.slice(1) : rows;

    return {
      messages: visibleRows.map(rowToStoredMessage),
      hasMore,
    };
  }

  async listModelHistory(
    ownerEmail: string,
    articleId: string,
  ): Promise<DiscussionHistoryItem[]> {
    const rows = await this.queryRows<HistoryRow>(
      `
        SELECT role, content, sequence
        FROM (
          SELECT
            message.sequence,
            message.role,
            LEFT(message.content, $4) AS content
          FROM article_discussion_messages AS message
          WHERE
            message.owner_email = $1
            AND message.article_id = $2
            AND message.status = 'complete'
            AND message.content <> ''
            AND EXISTS (
              SELECT 1
              FROM article_discussion_messages AS completed_assistant
              WHERE
                completed_assistant.owner_email = message.owner_email
                AND completed_assistant.article_id = message.article_id
                AND completed_assistant.request_id = message.request_id
                AND completed_assistant.role = 'assistant'
                AND completed_assistant.status = 'complete'
            )
          ORDER BY message.sequence DESC
          LIMIT $3
        ) AS recent_history
        ORDER BY sequence
      `,
      [
        normalizeOwnerEmail(ownerEmail),
        articleId,
        MAX_DISCUSSION_HISTORY_ITEMS,
        MAX_DISCUSSION_HISTORY_ITEM_CHARACTERS,
      ],
    );

    return boundHistoryCharacters(rows);
  }

  private async findTurnMessage(
    ownerEmail: string,
    articleId: string,
    requestId: string,
    role: DiscussionMessageRole,
  ) {
    const rows = await this.queryRows<DiscussionMessageRow>(
      `
        SELECT ${messageColumns}
        FROM article_discussion_messages
        WHERE
          owner_email = $1
          AND article_id = $2
          AND request_id = $3
          AND role = $4
        LIMIT 1
      `,
      [ownerEmail, articleId, requestId, role],
    );

    return rows[0] ? rowToStoredMessage(rows[0]) : null;
  }

  private async queryRows<T>(statement: string, params: unknown[] = []) {
    try {
      const client = this.queryClient ?? getDatabaseSql();
      return (await client.query(statement, params)) as T[];
    } catch (error) {
      if (error instanceof DiscussionPersistenceError) {
        throw error;
      }

      throw new DiscussionPersistenceError();
    }
  }
}

const messageColumns = `
  sequence,
  id,
  request_id,
  role,
  status,
  content,
  scope,
  selection_text,
  attempt_id,
  response_id,
  model,
  incomplete,
  input_tokens,
  output_tokens,
  total_tokens,
  context_scope,
  context_truncated,
  context_original_characters,
  context_included_characters,
  context_note,
  error_code,
  created_at,
  updated_at
`;

function rowToStoredMessage(row: DiscussionMessageRow): StoredDiscussionMessage {
  const stalePending =
    row.status === "pending" &&
    Date.parse(isoString(row.updated_at)) < Date.now() - attemptLeaseMilliseconds;
  const status = stalePending ? "error" : row.status;
  const inputTokens = optionalNumber(row.input_tokens);
  const outputTokens = optionalNumber(row.output_tokens);
  const totalTokens = optionalNumber(row.total_tokens);
  const contextOriginalCharacters = optionalNumber(
    row.context_original_characters,
  );
  const contextIncludedCharacters = optionalNumber(
    row.context_included_characters,
  );

  return {
    sequence: String(row.sequence),
    id: row.id,
    requestId: row.request_id,
    role: row.role,
    status,
    content: row.content,
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.selection_text ? { selection: row.selection_text } : {}),
    ...(row.response_id ? { responseId: row.response_id } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.incomplete !== null ? { incomplete: row.incomplete } : {}),
    ...(inputTokens !== undefined &&
    outputTokens !== undefined &&
    totalTokens !== undefined
      ? {
          usage: {
            inputTokens,
            outputTokens,
            totalTokens,
          },
        }
      : {}),
    ...(row.context_scope &&
    row.context_truncated !== null &&
    contextOriginalCharacters !== undefined &&
    contextIncludedCharacters !== undefined
      ? {
          context: {
            scope: row.context_scope,
            truncated: row.context_truncated,
            originalCharacters: contextOriginalCharacters,
            includedCharacters: contextIncludedCharacters,
            ...(row.context_note ? { note: row.context_note } : {}),
          },
        }
      : {}),
    ...(row.error_code || stalePending
      ? { errorCode: row.error_code ?? "internal" }
      : {}),
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
  };
}

function boundHistoryCharacters(rows: HistoryRow[]): DiscussionHistoryItem[] {
  const bounded: DiscussionHistoryItem[] = [];
  let remaining = MAX_DISCUSSION_HISTORY_CHARACTERS;

  for (let index = rows.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const row = rows[index];
    const content = row.content.slice(0, remaining);

    if (content) {
      bounded.push({ role: row.role, content });
      remaining -= content.length;
    }
  }

  return bounded.reverse();
}

function normalizeOwnerEmail(value: string) {
  return value.trim().toLowerCase();
}

function optionalNumber(value: number | string | null) {
  if (value === null) {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isoString(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
