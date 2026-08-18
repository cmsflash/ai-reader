export type SpeechLanguage = "zh-CN";

export type BrowserSpeechVoice = {
  name: string;
  lang: string;
  default?: boolean;
  localService?: boolean;
};

const hanPattern = /\p{Script=Han}/gu;
const latinPattern = /\p{Script=Latin}/gu;
const kanaPattern = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;

export function detectSpeechLanguage(
  text: string,
): SpeechLanguage | undefined {
  const hanCount = characterCount(text, hanPattern);

  if (hanCount < 2) {
    return undefined;
  }

  const kanaCount = characterCount(text, kanaPattern);

  if (kanaCount >= 2 && kanaCount * 2 >= hanCount) {
    return undefined;
  }

  const latinCount = characterCount(text, latinPattern);
  const comparableLetterCount = hanCount + latinCount;

  if (hanCount / comparableLetterCount < 0.25) {
    return undefined;
  }

  return "zh-CN";
}

export function browserSpeechPlan<T extends BrowserSpeechVoice>(
  text: string,
  voices: readonly T[],
  articleLanguage?: SpeechLanguage,
): { lang?: SpeechLanguage; voice: T | null } {
  const lang = articleLanguage ?? detectSpeechLanguage(text);

  return {
    lang,
    voice: lang ? selectBrowserSpeechVoice(voices, lang) : null,
  };
}

export function selectBrowserSpeechVoice<T extends BrowserSpeechVoice>(
  voices: readonly T[],
  language: SpeechLanguage,
): T | null {
  if (language !== "zh-CN") {
    return null;
  }

  return (
    voices
      .map((voice, index) => ({
        index,
        score: mandarinVoiceScore(voice),
        voice,
      }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.index - right.index,
      )[0]
      ?.voice ?? null
  );
}

function characterCount(text: string, pattern: RegExp) {
  return text.match(pattern)?.length ?? 0;
}

function mandarinVoiceScore(voice: BrowserSpeechVoice) {
  const lang = voice.lang.toLowerCase().replaceAll("_", "-");
  const name = voice.name.toLowerCase();

  if (
    lang.startsWith("yue") ||
    /(?:^|-)hk(?:-|$)|(?:^|-)mo(?:-|$)/u.test(lang) ||
    /cantonese|粤语|粵語|广东话|廣東話/u.test(name)
  ) {
    return 0;
  }

  let score = 0;

  if (lang === "zh-cn" || lang === "cmn-cn") {
    score = 100;
  } else if (lang.startsWith("zh-hans") || lang.startsWith("cmn-hans")) {
    score = 95;
  } else if (
    lang === "zh" ||
    lang.startsWith("zh-tw") ||
    lang.startsWith("zh-sg") ||
    lang.startsWith("zh-hant-tw") ||
    lang === "cmn" ||
    lang.startsWith("cmn-")
  ) {
    score = 70;
  }

  if (score === 0) {
    return 0;
  }

  if (/natural|premium|enhanced|neural/u.test(name)) {
    score += 12;
  }

  if (/google|xiaoxiao|yunxi|tingting|mandarin|普通话/u.test(name)) {
    score += 8;
  }

  return score;
}
