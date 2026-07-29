import { createHash } from "node:crypto";
import type {
  OpenAIRealtimeSession,
  OpenAIResponsesRequest,
} from "@/server/ai/articleDiscussion";

const responsesEndpoint = "https://api.openai.com/v1/responses";
const realtimeCallsEndpoint = "https://api.openai.com/v1/realtime/calls";
const defaultResponsesTimeoutMs = 45_000;
const defaultRealtimeTimeoutMs = 20_000;
const maxRealtimeAnswerCharacters = 256_000;

export type DiscussionReply = {
  reply: string;
  responseId?: string;
  incomplete: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

export class OpenAIServiceError extends Error {
  kind: "configuration" | "network" | "timeout" | "upstream" | "invalid-response";
  status?: number;

  constructor(input: {
    message: string;
    kind: OpenAIServiceError["kind"];
    status?: number;
  }) {
    super(input.message);
    this.name = "OpenAIServiceError";
    this.kind = input.kind;
    this.status = input.status;
  }
}

type OpenAIRequestOptions = {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export async function requestDiscussionReply(
  request: OpenAIResponsesRequest,
  safetySource: string,
  options: OpenAIRequestOptions = {},
): Promise<DiscussionReply> {
  const safetyIdentifier = createSafetyIdentifier(safetySource);
  const response = await openAIFetch(
    responsesEndpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...request,
        safety_identifier: safetyIdentifier,
      }),
    },
    {
      ...options,
      timeoutMs: options.timeoutMs ?? defaultResponsesTimeoutMs,
    },
  );

  if (!response.ok) {
    await discardResponseBody(response);
    throw new OpenAIServiceError({
      message: "The AI discussion service rejected the request.",
      kind: "upstream",
      status: response.status,
    });
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new OpenAIServiceError({
      message: "The AI discussion service returned an invalid response.",
      kind: "invalid-response",
      status: response.status,
    });
  }

  return parseDiscussionReply(payload, response.status);
}

export async function initiateRealtimeDiscussionCall(
  sdp: string,
  session: OpenAIRealtimeSession,
  safetySource: string,
  options: OpenAIRequestOptions = {},
) {
  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(session));

  const response = await openAIFetch(
    realtimeCallsEndpoint,
    {
      method: "POST",
      headers: {
        "OpenAI-Safety-Identifier": createSafetyIdentifier(safetySource),
      },
      body: form,
    },
    {
      ...options,
      timeoutMs: options.timeoutMs ?? defaultRealtimeTimeoutMs,
    },
  );

  if (!response.ok) {
    await discardResponseBody(response);
    throw new OpenAIServiceError({
      message: "The realtime discussion service rejected the request.",
      kind: "upstream",
      status: response.status,
    });
  }

  const declaredLength = Number(response.headers.get("content-length"));

  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maxRealtimeAnswerCharacters
  ) {
    await discardResponseBody(response);
    throw invalidRealtimeResponse(response.status);
  }

  const answer = await response.text();

  if (
    answer.length > maxRealtimeAnswerCharacters ||
    !/^v=0(?:\r?\n)/.test(answer) ||
    !/^m=audio\s/m.test(answer)
  ) {
    throw invalidRealtimeResponse(response.status);
  }

  return answer;
}

export function createSafetyIdentifier(value: string) {
  return createHash("sha256")
    .update(`ai-reader:${value.trim().toLowerCase()}`)
    .digest("hex");
}

function parseDiscussionReply(payload: unknown, status: number): DiscussionReply {
  const object = asRecord(payload);

  if (!object) {
    throw invalidDiscussionResponse(status);
  }

  const textParts: string[] = [];

  for (const output of arrayValue(object.output)) {
    const outputObject = asRecord(output);

    if (!outputObject || outputObject.type !== "message") {
      continue;
    }

    for (const content of arrayValue(outputObject.content)) {
      const contentObject = asRecord(content);

      if (
        contentObject?.type === "output_text" &&
        typeof contentObject.text === "string" &&
        contentObject.text.trim()
      ) {
        textParts.push(contentObject.text.trim());
      } else if (
        contentObject?.type === "refusal" &&
        typeof contentObject.refusal === "string" &&
        contentObject.refusal.trim()
      ) {
        textParts.push(contentObject.refusal.trim());
      }
    }
  }

  const reply = textParts.join("\n\n").trim();

  if (!reply) {
    throw invalidDiscussionResponse(status);
  }

  const usage = asRecord(object.usage);
  const inputTokens = nonNegativeInteger(usage?.input_tokens);
  const outputTokens = nonNegativeInteger(usage?.output_tokens);
  const totalTokens = nonNegativeInteger(usage?.total_tokens);

  return {
    reply,
    ...(typeof object.id === "string" ? { responseId: object.id } : {}),
    incomplete: object.status === "incomplete",
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
  };
}

async function openAIFetch(
  endpoint: string,
  init: RequestInit,
  options: OpenAIRequestOptions,
) {
  const apiKey =
    options.apiKey ??
    process.env.OPENAI_API_KEY_AI_READER?.trim() ??
    process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new OpenAIServiceError({
      message: "AI discussion is not configured.",
      kind: "configuration",
    });
  }

  const fetcher = options.fetch ?? globalThis.fetch;

  if (typeof fetcher !== "function") {
    throw new OpenAIServiceError({
      message: "A server-side fetch implementation is required.",
      kind: "configuration",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? defaultResponsesTimeoutMs,
  );

  try {
    return await fetcher(endpoint, {
      ...init,
      headers: {
        ...headersAsObject(init.headers),
        authorization: `Bearer ${apiKey}`,
      },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    throw new OpenAIServiceError({
      message: controller.signal.aborted
        ? "The AI discussion request timed out."
        : "The AI discussion service could not be reached.",
      kind: controller.signal.aborted ? "timeout" : "network",
    });
  } finally {
    clearTimeout(timeout);
  }
}

function headersAsObject(headers: HeadersInit | undefined) {
  return Object.fromEntries(new Headers(headers).entries());
}

async function discardResponseBody(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

function invalidDiscussionResponse(status: number) {
  return new OpenAIServiceError({
    message: "The AI discussion service returned no usable reply.",
    kind: "invalid-response",
    status,
  });
}

function invalidRealtimeResponse(status: number) {
  return new OpenAIServiceError({
    message: "The realtime discussion service returned an invalid SDP answer.",
    kind: "invalid-response",
    status,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}
