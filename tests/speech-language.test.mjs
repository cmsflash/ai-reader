import assert from "node:assert/strict";
import test from "node:test";
import {
  browserSpeechPlan,
  detectSpeechLanguage,
  selectBrowserSpeechVoice,
} from "../src/lib/speechLanguage.ts";

test("detects Chinese articles without confusing English or Japanese text", () => {
  assert.equal(detectSpeechLanguage("这是一个中文句子。"), "zh-CN");
  assert.equal(detectSpeechLanguage("這是一段繁體中文內容。"), "zh-CN");
  assert.equal(
    detectSpeechLanguage("今天我们讨论 OpenAI 的新模型和产品方向。"),
    "zh-CN",
  );
  assert.equal(
    detectSpeechLanguage(
      'This remains an English article with a short quote: "你好世界。"',
    ),
    undefined,
  );
  assert.equal(detectSpeechLanguage("これは日本語の文章です。"), undefined);
  assert.equal(detectSpeechLanguage("1234！？"), undefined);
});

test("prefers a natural mainland Mandarin browser voice", () => {
  const english = voice("English", "en-US", true);
  const taiwanese = voice("Chinese Taiwan", "zh-TW");
  const mainland = voice("Mandarin", "zh-CN");
  const naturalMainland = voice("Microsoft Xiaoxiao Online (Natural)", "zh-CN");

  assert.equal(
    selectBrowserSpeechVoice(
      [english, taiwanese, mainland, naturalMainland],
      "zh-CN",
    ),
    naturalMainland,
  );
});

test("falls back to another Chinese voice while preserving the Mandarin locale", () => {
  const english = voice("English", "en-US", true);
  const taiwanese = voice("Chinese Taiwan", "zh-TW");
  const cantonese = voice("Cantonese", "zh-HK");

  assert.equal(
    selectBrowserSpeechVoice([english, cantonese, taiwanese], "zh-CN"),
    taiwanese,
  );
  assert.equal(
    selectBrowserSpeechVoice([english, cantonese], "zh-CN"),
    null,
  );
  assert.deepEqual(browserSpeechPlan("你好。", [english]), {
    lang: "zh-CN",
    voice: null,
  });
});

function voice(name, lang, isDefault = false) {
  return {
    name,
    lang,
    default: isDefault,
    localService: true,
  };
}
