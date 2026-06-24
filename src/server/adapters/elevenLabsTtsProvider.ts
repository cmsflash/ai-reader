import type {
  SynthesizeSpeechInput,
  SynthesizedSpeech,
  TtsProvider,
} from "@/server/ports/ttsProvider";

type ElevenLabsTtsProviderOptions = {
  apiKey: string;
  voiceId: string;
  modelId: string;
  costPerThousandCharactersUsd?: number;
};

export class ElevenLabsTtsProvider implements TtsProvider {
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly costPerThousandCharactersUsd: number;

  constructor(options: ElevenLabsTtsProviderOptions) {
    this.apiKey = options.apiKey;
    this.voiceId = options.voiceId;
    this.modelId = options.modelId;
    this.costPerThousandCharactersUsd = options.costPerThousandCharactersUsd ?? 0;
  }

  async synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SynthesizedSpeech> {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
        this.voiceId,
      )}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "audio/mpeg",
          "xi-api-key": this.apiKey,
        },
        body: JSON.stringify({
          text: input.text,
          model_id: this.modelId,
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.8,
            use_speaker_boost: true,
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(await elevenLabsErrorMessage(response));
    }

    return {
      audio: await response.arrayBuffer(),
      contentType: response.headers.get("content-type") ?? "audio/mpeg",
      costUsd: estimateCost(input.text, this.costPerThousandCharactersUsd),
    };
  }
}

function estimateCost(text: string, costPerThousandCharactersUsd: number) {
  if (!Number.isFinite(costPerThousandCharactersUsd) || costPerThousandCharactersUsd <= 0) {
    return 0;
  }

  return Math.round((text.length / 1000) * costPerThousandCharactersUsd * 1_000_000) / 1_000_000;
}

async function elevenLabsErrorMessage(response: Response) {
  const fallback = `ElevenLabs request failed with ${response.status}.`;

  try {
    const body = (await response.json()) as {
      detail?: string | { message?: string };
      message?: string;
    };

    if (typeof body.detail === "string") {
      return body.detail;
    }

    return body.detail?.message ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}
