// The script host.
//
// Behaviour that is not expressible through the settings panel goes in a script.
// The model is the one from click-stream/phone: sources are TypeScript, esbuild
// bundles each entry point into a single self-contained IIFE, and the host calls
// a known entry function with a runtime `ctx` published to global scope before
// any module code runs. Here that function is `vellumRun(ctx)`.
//
// The sandbox is node:vm. That is a boundary against mistakes — a script that
// throws, loops or reaches for `require` fails alone instead of taking down the
// run — and explicitly not a boundary against hostile code. Scripts are local
// files the user wrote or installed; treat them with the same trust as the app.

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import * as logger from "./log.js";

/** `// ==VellumScript== … // ==/VellumScript==` header, mirroring DroidScript's. */
const HEADER = /\/\/\s*==VellumScript==([\s\S]*?)\/\/\s*==\/VellumScript==/;

export function parseMetadata(source, fallbackId) {
  const block = HEADER.exec(source);
  const meta = { id: fallbackId, name: fallbackId, version: "0.0.0", description: "" };
  if (!block) return meta;

  for (const line of block[1].split("\n")) {
    const m = /^\s*\/\/\s*@(\w+)\s+(.*?)\s*$/.exec(line);
    if (m) meta[m[1]] = m[2];
  }
  return meta;
}

/** Everything a script is handed. Anything not on here is unreachable from a script. */
export function buildContext({ cfg, personality, device, moveOptions, isPaused }) {
  const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

  /** Throws if the user has taken over, so a script unwinds at a safe point. */
  const yieldIfHuman = () => {
    if (isPaused()) {
      const e = new Error("yielded to user input");
      e.yielded = true;
      throw e;
    }
  };

  const guarded = async (fn) => {
    yieldIfHuman();
    const res = await fn();
    if (res?.aborted) {
      const e = new Error("stroke aborted");
      e.yielded = true;
      throw e;
    }
    return res;
  };

  return {
    config: cfg,
    personality,

    log: (msg) => logger.info(`script: ${msg}`),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, 10 * 60_000)))),
    rand,
    chance: (p) => Math.random() < p,
    pick: (list) => list[Math.floor(Math.random() * list.length)],

    /** Sample the configured dwell buckets: [probability, minMs, maxMs]. */
    dwell: () => {
      const buckets = cfg.advanced.dwellBuckets;
      const total = buckets.reduce((s, [p]) => s + p, 0);
      let r = Math.random() * total;
      for (const [p, lo, hi] of buckets) {
        if ((r -= p) <= 0) return Math.round(rand(lo, hi) * personality.dwellMult);
      }
      const [, lo, hi] = buckets[buckets.length - 1];
      return Math.round(rand(lo, hi) * personality.dwellMult);
    },

    yieldIfHuman,

    mouse: {
      pos: () => device.call("mouse.pos"),
      moveTo: (x, y, opts = {}) =>
        guarded(() => device.call("mouse.moveTo", { x, y, ...moveOptions(), ...opts },
          { timeoutMs: 20_000 })),
      moveWithin: (rect, opts = {}) =>
        guarded(() => device.call("mouse.moveWithin", { rect, pad: 60, ...moveOptions(), ...opts },
          { timeoutMs: 20_000 })),
      scroll: (dy, ms = 320) =>
        guarded(() => device.call("scroll", { dy, ms })),
    },

    app: {
      list: () => device.call("apps.list").then((r) => r.apps ?? []),
      activate: (bundleId) => guarded(() => device.call("apps.activate", { bundleId })),
      frontWindow: (bundleId) =>
        device.call("apps.frontWindow", { bundleId }).then((r) => (r.ok === false ? null : r.rect)),
    },

    // Gated actions. A script asking for one that is switched off gets a logged
    // no-op rather than an exception — the switch is the user's answer, and a
    // script should not be able to turn it into a crash.
    click: async (opts = {}) => {
      if (!cfg.actions.click) return logger.warn("script: click is switched off — ignored");
      // The safety fields go AFTER the spread, not before it. With the spread
      // last, `ctx.click({requireSafe: false})` silently disarmed the safe-zone
      // check and let a script click anywhere on screen.
      return guarded(() => device.call("click", {
        ...opts,
        requireSafe: true,
        padding: cfg.advanced.safeZonePaddingPx,
      }));
    },

    key: async (name) => {
      if (!cfg.actions.pressKeys) return logger.warn("script: keys are switched off — ignored");
      if (!cfg.advanced.keyAllowlist.includes(name)) {
        return logger.warn(`script: key "${name}" is not on the allowlist — ignored`);
      }
      return guarded(() => device.call("key", { keyCode: KEY_CODES[name] }));
    },
  };
}

/** Virtual key codes for the no-op modifiers the allowlist permits. */
const KEY_CODES = { shift: 56, control: 59, option: 58, command: 55 };

export class Script {
  constructor({ id, meta, source }) {
    this.id = id;
    this.meta = meta;
    this.source = source;
  }

  static fromFile(file) {
    const source = fs.readFileSync(file, "utf8");
    const id = path.basename(file).replace(/\.(m?js|ts)$/, "");
    return new Script({ id, meta: parseMetadata(source, id), source });
  }

  /**
   * Run the script's `vellumRun(ctx)` against a context.
   * @param {object} ctx
   * @param {number} timeoutMs Wall-clock ceiling for the synchronous portion.
   */
  async run(ctx, { timeoutMs = 5 * 60_000 } = {}) {
    const sandbox = {
      ctx,
      log: ctx.log,
      console: { log: ctx.log, warn: ctx.log, error: ctx.log },
      setTimeout,
      clearTimeout,
      Promise,
      Math,
      Date,
      JSON,
    };
    const context = vm.createContext(sandbox);

    // The timeout only bounds synchronous execution — vm cannot interrupt an
    // awaited promise. Scripts are cooperative: they yield at every ctx call, and
    // ctx.sleep is capped, so a runaway script stalls its own turn rather than
    // the process.
    new vm.Script(this.source, { filename: `${this.id}.js` }).runInContext(context, { timeout: 5000 });

    const entry = context.vellumRun ?? context.run;
    if (typeof entry !== "function") {
      throw new Error(`${this.id}: no vellumRun(ctx) function was defined`);
    }

    return await Promise.race([
      Promise.resolve(entry(ctx)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${this.id}: exceeded ${timeoutMs}ms`)), timeoutMs).unref?.()
      ),
    ]);
  }
}

/** Load every bundled script in a directory. */
export function loadScripts(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.(m?js)$/.test(n));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return [];
  }
  return names.map((n) => Script.fromFile(path.join(dir, n)));
}
