export type SynthesizeSpeechInput = {
  text: string;
};

export type SynthesizedSpeech = {
  audio: ArrayBuffer;
  contentType: string;
  costUsd?: number;
};

export interface TtsProvider {
  synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SynthesizedSpeech>;
}
