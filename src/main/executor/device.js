// Client for the Swift sidecar.
//
// The framing is the one from ig-export-extension-2/automate/native-host.js:
// [uint32 little-endian length][utf8 JSON body]. That host was a Chrome native
// messaging endpoint; the shape carries over unchanged because the problem is the
// same — a long-lived process, request/response with ids, plus unsolicited events
// pushed the other way.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the sidecar lives: inside the bundle when packaged, in the build output
 * when not.
 *
 * The check is for the file, not for `process.resourcesPath` — that variable is
 * always set under Electron, and in development it points inside Electron.app,
 * so testing it alone resolved to a path that never exists in dev. The spawn then
 * failed with ENOENT and the only symptom was an empty app picker.
 */
export function defaultBinaryPath() {
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, "vellum-input")
    : null;
  if (packaged && fs.existsSync(packaged)) return packaged;

  return path.join(HERE, "..", "..", "..", "native", "VellumInput", "dist", "vellum-input");
}

export class Device extends EventEmitter {
  #child = null;
  #buffer = Buffer.alloc(0);
  #pending = new Map();
  #nextId = 1;
  #closing = false;

  constructor({ binary = defaultBinaryPath() } = {}) {
    super();
    this.binary = binary;
  }

  get running() {
    return this.#child != null && this.#child.exitCode == null;
  }

  get pid() {
    return this.#child?.pid ?? null;
  }

  start() {
    if (this.running) return;

    // Checked up front so a missing build fails with a sentence that says what to
    // run, rather than an ENOENT on an async 'error' event that surfaces as an
    // empty app list three layers up.
    if (!fs.existsSync(this.binary)) {
      throw new Error(
        `sidecar not found at ${this.binary} — run "npm run build:native"`
      );
    }

    this.#closing = false;
    this.#child = spawn(this.binary, { stdio: ["pipe", "pipe", "pipe"] });

    this.#child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.#child.stderr.on("data", (chunk) => {
      this.emit("stderr", chunk.toString("utf8").trimEnd());
    });
    this.#child.on("exit", (code, signal) => {
      // Fail every in-flight call rather than leaving callers hanging on a
      // promise that can no longer be settled.
      for (const [, reject] of this.#pending.values()) {
        reject(new Error(`sidecar exited (code ${code}, signal ${signal})`));
      }
      this.#pending.clear();
      this.#child = null;
      if (!this.#closing) this.emit("crashed", { code, signal });
      this.emit("exit", { code, signal });
    });
    this.#child.on("error", (err) => this.emit("error", err));
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const len = this.#buffer.readUInt32LE(0);
      if (this.#buffer.length < 4 + len) break;
      const body = this.#buffer.subarray(4, 4 + len).toString("utf8");
      this.#buffer = this.#buffer.subarray(4 + len);

      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue; // a torn frame is not worth killing the connection over
      }

      if (msg.id != null && this.#pending.has(msg.id)) {
        const [resolve] = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        resolve(msg);
      } else if (msg.type) {
        this.emit(msg.type, msg);
      }
    }
  }

  /** Send a command and resolve with its reply. */
  call(cmd, fields = {}, { timeoutMs = 30_000 } = {}) {
    if (!this.running) return Promise.reject(new Error("sidecar is not running"));

    const id = this.#nextId++;
    const body = Buffer.from(JSON.stringify({ id, cmd, ...fields }), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`sidecar did not answer "${cmd}" within ${timeoutMs}ms`));
      }, timeoutMs);

      this.#pending.set(id, [
        (msg) => { clearTimeout(timer); resolve(msg); },
        (err) => { clearTimeout(timer); reject(err); },
      ]);

      this.#child.stdin.write(Buffer.concat([header, body]));
    });
  }

  /** Like call(), but throws when the sidecar reports the command failed. */
  async require(cmd, fields = {}, opts) {
    const res = await this.call(cmd, fields, opts);
    if (res.ok === false) throw new Error(res.error || `${cmd} failed`);
    return res;
  }

  async stop() {
    this.#closing = true;
    if (!this.running) return;
    try {
      await this.call("quit", {}, { timeoutMs: 1500 });
    } catch {
      // Already gone, or wedged — either way the kill below settles it.
    }
    this.#child?.kill("SIGKILL");
    this.#child = null;
  }
}
