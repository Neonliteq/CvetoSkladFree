/**
 * Verifies the dictation wiring in the real UI.
 *
 * A headless browser has no microphone, so `SpeechRecognition` is replaced with
 * a controllable stub before any page script runs. That exercises the whole
 * client path — button states, interim transcripts, field updates, errors — and
 * leaves only the vendor speech service itself untested.
 *
 * Usage: node scripts/src/check-voice-ui.mjs [width] [height]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signInBrowser } from "./auth-helper.mjs";
import { ensureScreenshotsDir, saveScreenshot } from "./screenshot-helper.mjs";

// Каталог снимков не хранится в репозитории: на чистой копии его создаём сами.
ensureScreenshotsDir();

const here = path.dirname(fileURLToPath(import.meta.url));
const width = Number(process.argv[2] ?? 1440);
const height = Number(process.argv[3] ?? 1000);
const port = 9342;
const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(path.join(tmpdir(), "dsh-voice-ui-"));

const browser = spawn(
  edge,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs before every page script: a scriptable stand-in for the speech engine. */
const STUB = `
window.__voice = { instances: 0, started: 0, stopped: 0, aborted: 0, lang: null, interim: null };
class FakeSpeechRecognition extends EventTarget {
  constructor() {
    super();
    this.lang = "";
    this.continuous = false;
    this.interimResults = true;
    this.maxAlternatives = 1;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.onstart = null;
    window.__voice.instances += 1;
    window.__voice.last = this;
  }
  start() {
    window.__voice.started += 1;
    window.__voice.lang = this.lang;
    window.__voice.interim = this.interimResults;
    if (this.onstart) this.onstart(new Event("start"));
  }
  stop() {
    window.__voice.stopped += 1;
    if (this.onend) this.onend(new Event("end"));
  }
  // On iOS the microphone indicator only goes out when the capture is aborted,
  // so the check counts these calls.
  abort() {
    window.__voice.aborted += 1;
  }
}
window.SpeechRecognition = FakeSpeechRecognition;
window.webkitSpeechRecognition = FakeSpeechRecognition;
`;

async function debuggingTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // not ready
    }
    await sleep(250);
  }
  throw new Error("Could not reach the Edge debugging endpoint");
}

class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async connect(wsUrl) {
    const client = new Cdp();
    client.#socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      client.#socket.addEventListener("open", resolve, { once: true });
      client.#socket.addEventListener("error", reject, { once: true });
    });
    client.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = client.#pending.get(message.id);
      if (!pending) return;
      client.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    return client;
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30000);
    });
  }

  close() {
    this.#socket.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

/** Feeds a recogniser result exactly like the engine does. */
const emit = (cdp, transcript, isFinal) =>
  evaluate(
    cdp,
    `(() => {
      const recognition = window.__voice.last;
      if (!recognition) return false;
      const alternative = { transcript: ${JSON.stringify(transcript)}, confidence: 0.9 };
      const result = { isFinal: ${isFinal}, length: 1, 0: alternative, item: () => alternative };
      const results = { length: 1, 0: result, item: () => result };
      recognition.onresult({ resultIndex: 0, results });
      return true;
    })()`,
  );

const COMPOSER_INPUT = `document.querySelector('form input:not([type=file])')`;

const composerState = (cdp) =>
  evaluate(
    cdp,
    `(() => {
      const mic = document.querySelector('button[aria-label="Начать голосовой ввод"]');
      const stop = document.querySelector('button[aria-label="Остановить голосовой ввод"]');
      const input = ${COMPOSER_INPUT};
      const hint = [...document.querySelectorAll('p')]
        .map((p) => p.textContent ?? '')
        .find((text) => text.includes('запись') || text.includes('продиктовать'));
      return {
        micButton: Boolean(mic),
        stopButton: Boolean(stop),
        listening: Boolean(stop) && !mic,
        value: input?.value ?? null,
        placeholder: input?.placeholder ?? null,
        hint: hint ?? null,
        sendDisabled: document.querySelector('button[type=submit]')?.disabled ?? null,
      };
    })()`,
  );

try {
  const cdp = await Cdp.connect(await debuggingTarget());
  const session = await signInBrowser(cdp);
  console.log('signed in:', session.cookies.map((c) => c.name).join(', '));
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
  await cdp.send("Page.navigate", { url: "http://127.0.0.1:22284/assistant" });
  await sleep(4000);

  const results = [];
  const record = (label, ok) => results.push([label, Boolean(ok)]);

  const initial = await composerState(cdp);
  console.log("initial:", JSON.stringify(initial));
  record("microphone button is offered when the browser supports speech", initial.micButton);
  record("nothing is recorded before the button is pressed", initial.value === "");

  // ------------------------------------------------------------- dictation
  await evaluate(cdp, `document.querySelector('button[aria-label="Начать голосовой ввод"]').click()`);
  await sleep(400);
  const config = await evaluate(cdp, `JSON.stringify(window.__voice)`);
  console.log("engine config:", config);
  const listeningState = await composerState(cdp);
  console.log("listening:", JSON.stringify(listeningState));
  record("pressing the button starts recognition", JSON.parse(config).started === 1);
  record("recognition is configured for Russian", JSON.parse(config).lang?.startsWith("ru"));
  record("interim results are requested", JSON.parse(config).interim === true);
  record("the button switches to the stop state", listeningState.listening);
  record(
    "the field prompts the user to speak",
    String(listeningState.placeholder).includes("Говорите"),
  );

  await emit(cdp, "добавь приход двадцать роз ", false);
  await sleep(300);
  const interim = await composerState(cdp);
  record("interim speech appears in the field", interim.value === "добавь приход двадцать роз");
  record("the command is not sent while speaking", interim.sendDisabled === false);

  await emit(cdp, "добавь приход двадцать роз по 150 ,  цена", false);
  await sleep(300);
  const replaced = await composerState(cdp);
  console.log("after second interim:", JSON.stringify(replaced.value));
  record(
    "a longer interim replaces the previous one instead of stacking",
    replaced.value === "добавь приход двадцать роз по 150, цена",
  );

  // Captured while recording, so the listening state is visible in the artifact.
  const listeningShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-voice-input.png"),
    Buffer.from(listeningShot.data, "base64"),
  );

  await emit(cdp, "добавь приход двадцать роз по 150 ,  цена окончательная .", true);
  await sleep(400);
  const final = await composerState(cdp);
  console.log("final:", JSON.stringify(final.value));
  record(
    "the final result is cleaned up and left in the field",
    final.value === "добавь приход двадцать роз по 150, цена окончательная.",
  );

  // Find and click in one expression: a separate lookup races with React's
  // re-renders and can observe a detached node.
  const clicked = await evaluate(
    cdp,
    `(() => {
      const button = document.querySelector('button[aria-label="Остановить голосовой ввод"]');
      if (!button) return 'кнопки нет';
      button.click();
      return 'нажата';
    })()`,
  );
  console.log("stop click:", clicked);
  await sleep(400);
  const stopped = await composerState(cdp);
  const stopConfig = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__voice)`));
  record("pressing again stops recognition", stopConfig.stopped >= 1);
  record(
    "the microphone is released, not just stopped (iOS keeps it on otherwise)",
    stopConfig.aborted >= 1,
    `abort вызван ${stopConfig.aborted} раз`,
  );
  record("the button returns to the microphone state", stopped.micButton && !stopped.listening);
  record("the dictated text survives stopping", stopped.value === final.value);
  record("the user still confirms the command manually", stopped.sendDisabled === false);

  // Dictation must not outlive the page: on iOS the indicator stays lit after a
  // refresh when the capture is still open.
  const micLabels = await evaluate(
    cdp,
    `JSON.stringify([...document.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')))`,
  );
  console.log("buttons after stopping:", micLabels);
  await evaluate(cdp, `document.querySelector('button[aria-label="Начать голосовой ввод"]').click()`);
  await sleep(300);
  const beforeHide = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__voice)`));
  await evaluate(cdp, `window.dispatchEvent(new Event('pagehide'))`);
  await sleep(300);
  const afterHide = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__voice)`));
  record(
    "leaving the page releases the microphone",
    afterHide.aborted > beforeHide.aborted,
    `abort: до ${beforeHide.aborted}, после ${afterHide.aborted}`,
  );

  // Sending is still an explicit action.
  await evaluate(cdp, `document.querySelector('button[type=submit]').click()`);
  await sleep(2500);
  const sent = await evaluate(
    cdp,
    `(() => {
      const own = [...document.querySelectorAll('p')]
        .map((p) => p.textContent ?? '')
        .filter((text) => text.includes('двадцать роз'));
      const input = ${COMPOSER_INPUT};
      return { own: own.length, cleared: input?.value === '' };
    })()`,
  );
  console.log("after send:", JSON.stringify(sent));
  record("the dictated command is sent as a normal message", sent.own >= 1);
  record("the field is cleared after sending", sent.cleared);

  // ---------------------------------------------------------------- errors
  await evaluate(cdp, `document.querySelector('button[aria-label="Начать голосовой ввод"]').click()`);
  await sleep(400);
  await evaluate(
    cdp,
    `(() => {
      const recognition = window.__voice.last;
      recognition.onerror({ error: 'not-allowed', message: 'denied' });
      recognition.onend(new Event('end'));
      return true;
    })()`,
  );
  await sleep(900);
  const denied = await evaluate(
    cdp,
    `(() => {
      const toast = [...document.querySelectorAll('[data-sonner-toast]')]
        .map((element) => element.innerText.replace(/\\s+/g, ' ').trim());
      const mic = document.querySelector('button[aria-label="Начать голосовой ввод"]');
      return { toast: toast[toast.length - 1] ?? null, backToMic: Boolean(mic) };
    })()`,
  );
  console.log("denied:", JSON.stringify(denied));
  record(
    "a denied microphone is explained to the user",
    String(denied.toast).includes("доступ к микрофону"),
  );
  record("the button recovers after a failure", denied.backToMic);

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-voice-errors.png", shot.data);

  console.log("\nresults:");
  let failed = 0;
  for (const [label, ok] of results) {
    if (!ok) failed += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  cdp.close();
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  browser.kill();
  await sleep(600);
  rmSync(profile, { recursive: true, force: true });
}