import type {
  DiscussionHistoryItem,
  DiscussionScope,
} from "@/server/ai/articleDiscussion";

export type DiscussionMessageRole = "user" | "assistant";
export type DiscussionMessageStatus = "pending" | "complete" | "error";

export type DiscussionUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type DiscussionContextMetadata = {
  scope: DiscussionScope;
  truncated: boolean;
  originalCharacters: number;
  includedCharacters: number;
  note?: string;
};

export type StoredDiscussionMessage = {
  sequence: string;
  id: string;
  requestId: string;
  role: DiscussionMessageRole;
  status: DiscussionMessageStatus;
  content: string;
  scope?: DiscussionScope;
  selection?: string;
  responseId?: string;
  model?: string;
  incomplete?: boolean;
  usage?: DiscussionUsage;
  context?: DiscussionContextMetadata;
  errorCode?: DiscussionFailureCode;
  createdAt: string;
  updatedAt: string;
};

export type DiscussionFailureCode =
  | "configuration"
  | "network"
  | "timeout"
  | "upstream"
  | "invalid-response"
  | "internal";

export type ClaimDiscussionTurnInput = {
  ownerEmail: string;
  articleId: string;
  requestId: string;
  message: string;
  scope: DiscussionScope;
  selection?: string;
  model: string;
};

export type ClaimDiscussionTurnResult =
  | {
      kind: "missing-article";
    }
  | {
      kind: "conflict";
    }
  | {
      kind: "claimed" | "existing";
      user: StoredDiscussionMessage;
      assistant: StoredDiscussionMessage;
      attemptId?: string;
    };

export type CompleteDiscussionAssistantInput = {
  ownerEmail: string;
  articleId: string;
  requestId: string;
  attemptId: string;
  reply: string;
  responseId?: string;
  model: string;
  incomplete: boolean;
  usage?: DiscussionUsage;
  context: DiscussionContextMetadata;
};

export interface DiscussionRepository {
  claimTurn(
    input: ClaimDiscussionTurnInput,
  ): Promise<ClaimDiscussionTurnResult>;
  completeAssistant(
    input: CompleteDiscussionAssistantInput,
  ): Promise<StoredDiscussionMessage | null>;
  failAssistant(input: {
    ownerEmail: string;
    articleId: string;
    requestId: string;
    attemptId: string;
    errorCode: DiscussionFailureCode;
  }): Promise<StoredDiscussionMessage | null>;
  listArticleMessages(
    ownerEmail: string,
    articleId: string,
  ): Promise<{
    messages: StoredDiscussionMessage[];
    hasMore: boolean;
  }>;
  listModelHistory(
    ownerEmail: string,
    articleId: string,
  ): Promise<DiscussionHistoryItem[]>;
}

export class DiscussionPersistenceError extends Error {
  constructor() {
    super("Discussion persistence is unavailable.");
    this.name = "DiscussionPersistenceError";
  }
}
