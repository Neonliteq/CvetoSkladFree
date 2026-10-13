/**
 * Reports whether browser-native voice input is available in this environment:
 * the Web Speech API surface, the page's secure-context status, the microphone
 * permission state, and whether the speech service host is reachable.
 *
 * Usage: node scripts/src/check-voice-support.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = 9341;
const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(path.join(tmpdir(), "dsh-voice-probe-"));
const page = process.env.UI_BASE ?? "http://127.0.0.1:22284/assistant";

const browser = spawn(
  edge,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function debuggingTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const found = targets.find((target) => target.type === "page");
      if (found?.webSocketDebuggerUrl) return found.webSocketDebuggerUrl;
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

try {
  const cdp = await Cdp.connect(await debuggingTarget());
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: page });
  await sleep(3000);

  const result = await cdp.send("Runtime.evaluate", {
    expression: `(async () => {
      const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      let permission = "unknown";
      try {
        permission = (await navigator.permissions.query({ name: "microphone" })).state;
      } catch (error) {
        permission = "unavailable: " + error.message;
      }
      return {
        secureContext: window.isSecureContext,
        origin: window.location.origin,
        speechRecognition: Boolean(Recognition),
        implementation: Recognition ? Recognition.name || "SpeechRecognition" : null,
        speechSynthesis: Boolean(window.speechSynthesis),
        mediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
        microphonePermission: permission,
        languages: navigator.languages,
        userAgent: navigator.userAgent.slice(0, 120),
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log("browser capabilities:");
  console.log(JSON.stringify(result.result.value, null, 2));

  // Chrome/Edge stream audio to a Google speech endpoint; if it is unreachable
  // the API exists but recognition never returns a result.
  const pageCheck = await cdp.send("Runtime.evaluate", {
    expression: `(async () => {
      try {
        await fetch("https://www.google.com/speech-api/v2/recognize?client=chromium&lang=ru-RU", {
          mode: "no-cors",
          cache: "no-store",
        });
        return "reachable";
      } catch (error) {
        return "unreachable: " + error.message;
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log("speech service:", pageCheck.result.value);
  cdp.close();
} finally {
  browser.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
