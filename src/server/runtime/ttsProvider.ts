import { ElevenLabsTtsProvider } from "@/server/adapters/elevenLabsTtsProvider";
import type { TtsProvider } from "@/server/ports/ttsProvider";

let provider: TtsProvider | null = null;

export function getTtsProvider(): TtsProvider {
  if (provider) {
    return provider;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not configured.");
  }

  provider = new ElevenLabsTtsProvider({
    apiKey,
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb",
    modelId: process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2",
    costPerThousandCharactersUsd: parseOptionalNumber(
      process.env.ELEVENLABS_COST_PER_1K_CHARS_USD,
    ),
  });

  return provider;
}

function parseOptionalNumber(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
