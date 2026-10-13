/**
 * Dictation state that is worth unit testing, kept free of React and of the
 * browser API.
 */

/**
 * Joins the text that was already in the field with the recognised speech.
 *
 * The engine keeps re-sending the whole utterance, so the recognised part is
 * always taken as a whole and appended to the original text rather than merged
 * word by word. That makes the result stable while interim results change.
 */
export function mergeTranscript(base: string, recognised: string): string {
  const spoken = recognised.trim()
  if (!spoken) return base
  if (!base) return spoken
  return /\s$/u.test(base) ? `${base}${spoken}` : `${base} ${spoken}`
}

/** A spoken "запятая" should become punctuation, not a word. */
export function applySpokenPunctuation(text: string): string {
  return text
    .replace(/\s*,\s*/gu, ", ")
    .replace(/\s+([.!?])/gu, "$1")
    .replace(/\s{2,}/gu, " ")
    .trim()
}

/**
 * Turns a SpeechRecognition error code into something a shop worker can act on.
 * `null` means the failure needs no message (the user stopped on purpose).
 */
export function describeVoiceError(code: string): string | null {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Браузер не получил доступ к микрофону. Разрешите его в настройках сайта и попробуйте снова."
    case "no-speech":
      return "Речь не распознана — попробуйте ещё раз ближе к микрофону."
    case "audio-capture":
      return "Микрофон не найден. Проверьте, что он подключён."
    case "network":
      return "Нет связи с сервисом распознавания речи. Проверьте интернет."
    case "aborted":
      return null
    default:
      return "Не удалось распознать речь. Попробуйте ещё раз."
  }
}
