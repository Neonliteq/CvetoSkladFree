import { useCallback, useEffect, useRef, useState } from "react"
import {
  applySpokenPunctuation,
  describeVoiceError,
  mergeTranscript,
} from "@/lib/voice-input"

type Options = {
  /** Called with the full field value while the user is still speaking. */
  onTranscript: (text: string) => void
}

const recognitionConstructor = () =>
  typeof window === "undefined"
    ? undefined
    : window.SpeechRecognition ?? window.webkitSpeechRecognition

/**
 * Browser-native dictation for the assistant.
 *
 * Recognition runs in the browser (Chromium streams the audio to its speech
 * service), so there is no provider key and no round trip through our API. The
 * recognised text is only placed in the input field — sending the command stays
 * a deliberate action, because a misheard word would otherwise post a wrong
 * stock movement.
 */
export function useVoiceInput({ onTranscript }: Options) {
  const [isSupported, setIsSupported] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  // Text that was in the field when dictation started, plus the language.
  const baseRef = useRef("")
  const langRef = useRef("ru-RU")
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript

  useEffect(() => {
    setIsSupported(Boolean(recognitionConstructor()))
    if (typeof navigator !== "undefined" && navigator.language) {
      langRef.current = navigator.language
    }
  }, [])

  /**
   * Releases the microphone for real.
   *
   * `stop()` only asks the engine to finish: on iOS Safari the audio session
   * stays open afterwards, and the orange microphone indicator remains lit even
   * after the text arrives. `abort()` tears the capture down immediately, which
   * is what we want in every case here — the transcript is already delivered by
   * then, and a half-recognised word is worse than none. The extra `stop()` call
   * makes this safe on engines that ignore `abort()`.
   */
  const release = useCallback(() => {
    const recognition = recognitionRef.current
    if (!recognition) return
    recognitionRef.current = null
    try {
      recognition.abort()
    } catch {
      // Already finished.
    }
    try {
      recognition.stop()
    } catch {
      // Already finished.
    }
    setIsListening(false)
  }, [])

  // Dictation must not survive the component, the tab or the page going away:
  // on iOS the microphone indicator otherwise stays on after a refresh.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") release()
    }
    window.addEventListener("pagehide", release)
    window.addEventListener("beforeunload", release)
    document.addEventListener("visibilitychange", onHide)
    return () => {
      window.removeEventListener("pagehide", release)
      window.removeEventListener("beforeunload", release)
      document.removeEventListener("visibilitychange", onHide)
      release()
    }
  }, [release])

  const stop = useCallback(() => {
    release()
  }, [release])

  const start = useCallback((baseText: string) => {
    const Recognition = recognitionConstructor()
    if (!Recognition) {
      setError("Этот браузер не поддерживает голосовой ввод. Откройте склад в Chrome или Edge.")
      return
    }
    // A previous session may still hold the microphone.
    release()
    setError(null)
    baseRef.current = baseText
    const recognition = new Recognition()
    recognition.lang = langRef.current
    recognition.continuous = false
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onstart = () => setIsListening(true)
    recognition.onresult = (event) => {
      let recognised = ""
      for (let index = 0; index < event.results.length; index += 1) {
        recognised += event.results[index][0]?.transcript ?? ""
      }
      onTranscriptRef.current(
        applySpokenPunctuation(mergeTranscript(baseRef.current, recognised)),
      )
    }
    recognition.onerror = (event) => {
      const message = describeVoiceError(event.error)
      if (message) setError(message)
    }
    recognition.onend = () => {
      // The engine finished on its own. Only react when this instance is still
      // the current one: a session that was already stopped, or a newer session
      // started afterwards, must not be touched here — releasing someone else's
      // capture is exactly how a fresh dictation dies right after it starts.
      if (recognitionRef.current !== recognition) return
      recognitionRef.current = null
      setIsListening(false)
      // Tear the capture down as well: on iOS the microphone indicator stays lit
      // while the audio session is open, even though recognition has ended.
      try {
        recognition.abort()
      } catch {
        // Already finished.
      }
    }

    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch {
      // start() throws when it is called while an instance is already running.
      recognitionRef.current = null
      setError("Диктовка уже запущена. Подождите немного и повторите.")
    }
  }, [release])

  const toggle = useCallback(
    (baseText: string) => {
      if (isListening) stop()
      else start(baseText)
    },
    [isListening, start, stop],
  )

  return { isSupported, isListening, error, start, stop, toggle, clearError: () => setError(null) }
}
