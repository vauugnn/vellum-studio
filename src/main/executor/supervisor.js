// Runs the executor in an Electron utilityProcess and keeps it alive.
//
// The executor is deliberately kept out of the main process. It drives a stroke
// by blocking on wall-clock deadlines and it hosts user-written scripts; neither
// belongs on the thread that also has to keep a window responsive. A crash in
// either takes down the child and nothing else.
//
// The transport is postMessage rather than the framed stdio the sidecar uses —
// structured clone is already there, and framing exists on that boundary only
// because a Swift process cannot receive a JS object.

import { utilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Grows with each successive crash so a broken build does not spin. */
const RESTART_DELAYS_MS = [1000, 2000, 5000, 15000, 30000];

export class Supervisor {
  #child = null;
  #crashes = 0;
  #stopping = false;
  #restartTimer = null;

  /**
   * @param {object} o
   * @param {Function} o.onMessage  called with each message from the executor
   * @param {Function} [o.onExit]
   */
  constructor({ onMessage, onExit = () => {} }) {
    this.onMessage = onMessage;
    this.onExit = onExit;
  }

  get running() {
    return this.#child != null;
  }

  start() {
    if (this.#child || this.#stopping) return;

    this.#child = utilityProcess.fork(path.join(HERE, "host.js"), [], {
      serviceName: "vellum-executor",
      stdio: "pipe",
    });

    this.#child.on("message", (msg) => this.onMessage(msg));

    // The child's stdio is piped, so anything it prints is captured here and goes
    // nowhere else. Forward it to the terminal as well as to the UI — without
    // this, `npm run dev` is silent about everything the executor is doing, and
    // diagnosing it means re-running the whole thing headless.
    const forward = (level) => (d) => {
      const text = d.toString().trimEnd();
      if (!text) return;
      process[level === "error" ? "stderr" : "stdout"].write(`${text}\n`);
      this.onMessage({ type: "log", level, msg: text });
    };

    this.#child.stdout?.on("data", forward("info"));
    this.#child.stderr?.on("data", forward("error"));

    this.#child.on("exit", (code) => {
      this.#child = null;
      this.onExit(code);
      if (this.#stopping) return;

      // A clean exit is the executor deciding it is done; only a crash restarts.
      if (code === 0) return;

      const delay = RESTART_DELAYS_MS[Math.min(this.#crashes, RESTART_DELAYS_MS.length - 1)];
      this.#crashes++;
      this.onMessage({
        type: "log",
        level: "error",
        msg: `executor exited (${code}) — restarting in ${delay / 1000}s`,
      });
      this.#restartTimer = setTimeout(() => this.start(), delay);
    });

    // A run that stays up is evidence the fault is fixed, so forget the history.
    setTimeout(() => {
      if (this.#child) this.#crashes = 0;
    }, 60_000);
  }

  send(msg) {
    this.#child?.postMessage(msg);
  }

  stop() {
    this.#stopping = true;
    clearTimeout(this.#restartTimer);
    this.#child?.postMessage({ type: "shutdown" });

    // Give the executor a moment to stop the sidecar cleanly; a killed parent
    // would otherwise leave vellum-input running with no one talking to it.
    const child = this.#child;
    setTimeout(() => child?.kill(), 2000);
    this.#child = null;
  }
}
