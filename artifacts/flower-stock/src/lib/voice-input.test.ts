import assert from "node:assert/strict";
import test from "node:test";
import {
  applySpokenPunctuation,
  describeVoiceError,
  mergeTranscript,
} from "./voice-input.ts";

test("starts the field with what was recognised", () => {
  assert.equal(mergeTranscript("", "добавь приход 20 роз"), "добавь приход 20 роз");
});

test("appends speech to the text that was already typed", () => {
  assert.equal(
    mergeTranscript("Добавь приход", "20 роз по 150"),
    "Добавь приход 20 роз по 150",
  );
});

test("does not double the separator when the field ends with a space", () => {
  assert.equal(mergeTranscript("Добавь приход ", "20 роз"), "Добавь приход 20 роз");
});

test("keeps the typed text when nothing was recognised", () => {
  assert.equal(mergeTranscript("остаток ленты", ""), "остаток ленты");
  assert.equal(mergeTranscript("остаток ленты", "   "), "остаток ленты");
});

test("interim results replace the previous recognised part instead of stacking", () => {
  // The engine re-sends the whole utterance; the base text is the anchor.
  const base = "Спиши";
  assert.equal(mergeTranscript(base, "5"), "Спиши 5");
  assert.equal(mergeTranscript(base, "5 увядших"), "Спиши 5 увядших");
  assert.equal(mergeTranscript(base, "5 увядших пионов"), "Спиши 5 увядших пионов");
});

test("cleans up spacing around punctuation", () => {
  assert.equal(
    applySpokenPunctuation("Добавь приход 20 роз ,  цена 150 ."),
    "Добавь приход 20 роз, цена 150.",
  );
  assert.equal(applySpokenPunctuation("  лишние   пробелы  "), "лишние пробелы");
});

test("explains a denied microphone in plain language", () => {
  assert.match(String(describeVoiceError("not-allowed")), /доступ к микрофону/u);
  assert.match(String(describeVoiceError("service-not-allowed")), /доступ к микрофону/u);
});

test("explains silence, a missing microphone and a network failure", () => {
  assert.match(String(describeVoiceError("no-speech")), /не распознана/u);
  assert.match(String(describeVoiceError("audio-capture")), /не найден/u);
  assert.match(String(describeVoiceError("network")), /интернет/u);
});

test("a user-initiated stop produces no error message", () => {
  assert.equal(describeVoiceError("aborted"), null);
});

test("an unknown failure still gets a usable message", () => {
  assert.match(String(describeVoiceError("something-new")), /Не удалось/u);
});
