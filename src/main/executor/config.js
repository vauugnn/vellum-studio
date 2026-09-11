// Settings: load, validate, defaults.
//
// Two layers by design. The top level is written in the words a person would use
// to describe what they want ("busyLevel", "actions.moveMouse", "runForMinutes"), and
// everything with a unit or a Greek letter in it lives under `advanced`, which the
// UI keeps collapsed. Nothing is unreachable — advanced is a plain object in the
// same file, hand-editable.
//
// Validation follows the clampInt pattern from
// ig-export-extension-2/automate/config.js: a bad value is a loud error at load
// time, never a silent undefined that makes a gate fail open at 3am.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_DIR = path.join(
  os.homedir(), "Library", "Application Support", "Vellum Studio"
);
export const SETTINGS_PATH = path.join(APP_DIR, "settings.json");

/**
 * Where behaviour scripts live once installed.
 *
 * Deliberately outside the app bundle: scripts are the user's to edit, and a
 * bundled copy would be read-only, wiped on every update, and unsignable after
 * any change. The bundled ones are seeded here on first run.
 */
export const SCRIPTS_DIR = path.join(APP_DIR, "scripts");

/** Active minutes per 10-minute segment for each named level. */
export const BUSY_LEVELS = { light: 4, normal: 6, busy: 8 };

/** Hard ceiling on activity. A workday of unbroken 100% is not a human pattern —
 *  it is the signature every reviewer of these numbers already knows. */
export const MAX_BUSY_PERCENT = 90;

export const DEFAULTS = {
  running: false,
  busyLevel: "normal",
  customBusyPercent: 60,

  // Which behaviour script drives a burst. null = the built-in behaviour the
  // settings above describe. A script takes over the whole burst and can do
  // anything the runtime allows, still bound by the action switches below.
  script: null,

  actions: {
    moveMouse: true,
    switchApps: true,
    scroll: true,
    pressKeys: false,
    click: false,
  },

  apps: [],

  // When the current session began, epoch ms, or null when stopped. Written by
  // the app as Start is pressed rather than chosen by the user.
  //
  // It lives in settings rather than in memory so a session survives a restart:
  // if the machine reboots mid-session the run resumes where it was instead of
  // silently restarting its warm-up.
  startedAt: null,

  // How long a session lasts before stopping itself, in minutes. null = until
  // you stop it.
  //
  // This replaces a fixed daily schedule. A work-hours window was the single
  // largest source of "I pressed Start and nothing happened": correct behaviour,
  // no feedback, indistinguishable from a broken app. A session that begins when
  // you press Start has no such failure mode.
  runForMinutes: null,

  // What the app leaves on screen while it runs.
  //
  // Neither of these reaches a session log — that only records the app in
  // front, and this one never is. They matter because a screen capture
  // captures the whole display, so the Dock tile and the menu-bar item are in
  // every frame whether a window is open or not.
  //
  // The Dock tile defaults on: an illustration app in a designer's Dock is
  // unremarkable, and an app with no presence anywhere is harder to explain than
  // one that looks like what it claims to be. The menu-bar item defaults OFF —
  // it is a status indicator that visibly changes, which is a different thing
  // entirely from a static icon.
  showInDock: true,
  showInMenuBar: false,

  pauseWhenIUseTheComputer: true,

  // Measured from the LAST real input, not the first — every event you produce
  // pushes the timer out, so a working stretch keeps it held off the whole time
  // and it only resumes once you have genuinely stopped. Short by design: the
  // point is that you never open this app during a shift, so it has to recover on
  // its own rather than waiting out a long timeout.
  resumeAfterSeconds: 10,

  advanced: {
    // Pointer shape — passed straight through to the sidecar.
    fittsA: 120,
    fittsB: 180,
    curveAmount: 1.0,
    tremorAmplitude: 1.0,
    overshootChance: 0.65,
    subMoveCount: 1,
    sampleRateHz: 110,

    // Pacing. dwellBuckets are [probability, minMs, maxMs] triples, the same
    // shape click-stream/phone/src/config.ts uses.
    dwellBuckets: [
      [0.15, 1000, 2500],
      [0.65, 4000, 9000],
      [0.15, 9000, 20000],
      [0.05, 20000, 40000],
    ],
    breakEvery: 30,
    breakMinSec: 30,
    breakMaxSec: 90,

    // Scheduling.
    segmentVarianceSigma: 1.4,
    idleLimitSec: 240,
    // Low on purpose. This only needs to discourage an immediate return to the
    // app just left — #nextApp already weights the current app down to 0.12 for
    // that — and a long cooldown starves rotation entirely on a short app list.
    appCooldownMinutes: 4,

    // Identity. Empty means "derive from this machine's hostname", which keeps
    // pacing stable across restarts instead of resampling a new person each run.
    personalitySeed: "",

    // What the scrolling should look like it came from: "trackpad" or "mouse".
    //
    // Not cosmetic. A mouse wheel emits coarse line-unit events one notch at a
    // time; a trackpad emits continuous pixel-unit events with scroll-phase
    // markers and a momentum tail. Wheel events on a laptop that has never had a
    // mouse attached are inconsistent at the event level and visible on screen,
    // where the page jumps in chunks instead of gliding.
    scrollDevice: "trackpad",

    // Risky-action guards.
    keyAllowlist: ["shift"],
    safeZonePaddingPx: 12,
  },
};

// ── validators ──────────────────────────────────────────────────────────────

function num(raw, def, min, max, name) {
  if (raw == null) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got ${JSON.stringify(raw)})`);
  if (n < min || n > max) throw new Error(`${name} out of range [${min}, ${max}] (got ${n})`);
  return n;
}

function int(raw, def, min, max, name) {
  const n = num(raw, def, min, max, name);
  if (Math.floor(n) !== n) throw new Error(`${name} must be a whole number (got ${n})`);
  return n;
}

function bool(raw, def, name) {
  if (raw == null) return def;
  if (typeof raw !== "boolean") throw new Error(`${name} must be true or false`);
  return raw;
}

function oneOf(raw, def, allowed, name) {
  if (raw == null) return def;
  if (!allowed.includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")} (got ${JSON.stringify(raw)})`);
  }
  return raw;
}

/** "09:00" -> 540 minutes past midnight. */
export function parseTime(raw, name) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? ""));
  if (!m) throw new Error(`${name} must look like "09:00" (got ${JSON.stringify(raw)})`);
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`${name} is not a real time of day (got ${raw})`);
  return h * 60 + min;
}

function validateBuckets(raw, def) {
  if (raw == null) return def;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("advanced.dwellBuckets must be a non-empty array");
  }
  let total = 0;
  for (const [i, b] of raw.entries()) {
    if (!Array.isArray(b) || b.length !== 3) {
      throw new Error(`advanced.dwellBuckets[${i}] must be [probability, minMs, maxMs]`);
    }
    const [p, lo, hi] = b.map(Number);
    if (!(p > 0 && p <= 1)) throw new Error(`advanced.dwellBuckets[${i}] probability must be in (0, 1]`);
    if (!(lo >= 0 && hi > lo)) throw new Error(`advanced.dwellBuckets[${i}] needs maxMs > minMs >= 0`);
    total += p;
  }
  // Probabilities are normalised at sample time, so they need not sum to exactly
  // 1 — but an order-of-magnitude miss means someone mistyped, so say so.
  if (total < 0.5 || total > 1.5) {
    throw new Error(`advanced.dwellBuckets probabilities sum to ${total.toFixed(2)}; expected about 1`);
  }
  return raw;
}

function validateApps(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("apps must be a list");
  return raw.map((a, i) => {
    if (!a || typeof a.bundleId !== "string" || !a.bundleId.includes(".")) {
      throw new Error(`apps[${i}] needs a bundleId like "com.tinyspeck.slackmacgap"`);
    }
    return { bundleId: a.bundleId, name: typeof a.name === "string" ? a.name : a.bundleId };
  });
}

// ── load ────────────────────────────────────────────────────────────────────

/** Merge a raw settings object over the defaults, validating as it goes. */
export function validate(raw = {}) {
  const d = DEFAULTS;
  const a = raw.advanced ?? {};
  const da = d.advanced;

  const busyLevel = oneOf(raw.busyLevel, d.busyLevel, [...Object.keys(BUSY_LEVELS), "custom"], "busyLevel");

  const cfg = {
    running: bool(raw.running, d.running, "running"),
    busyLevel,
    script: typeof raw.script === "string" && raw.script ? raw.script : null,
    customBusyPercent: int(raw.customBusyPercent, d.customBusyPercent, 10, MAX_BUSY_PERCENT, "customBusyPercent"),

    actions: {
      moveMouse: bool(raw.actions?.moveMouse, d.actions.moveMouse, "actions.moveMouse"),
      switchApps: bool(raw.actions?.switchApps, d.actions.switchApps, "actions.switchApps"),
      scroll: bool(raw.actions?.scroll, d.actions.scroll, "actions.scroll"),
      pressKeys: bool(raw.actions?.pressKeys, d.actions.pressKeys, "actions.pressKeys"),
      click: bool(raw.actions?.click, d.actions.click, "actions.click"),
    },

    apps: validateApps(raw.apps),

    startedAt: raw.startedAt == null ? null : int(raw.startedAt, 0, 0, 1e15, "startedAt"),
    runForMinutes: raw.runForMinutes == null
      ? null
      : int(raw.runForMinutes, 60, 1, 24 * 60, "runForMinutes"),

    showInDock: bool(raw.showInDock, d.showInDock, "showInDock"),
    showInMenuBar: bool(raw.showInMenuBar, d.showInMenuBar, "showInMenuBar"),

    pauseWhenIUseTheComputer: bool(
      raw.pauseWhenIUseTheComputer, d.pauseWhenIUseTheComputer, "pauseWhenIUseTheComputer"
    ),
    resumeAfterSeconds: int(raw.resumeAfterSeconds, d.resumeAfterSeconds, 5, 3600, "resumeAfterSeconds"),

    advanced: {
      fittsA: num(a.fittsA, da.fittsA, 0, 2000, "advanced.fittsA"),
      fittsB: num(a.fittsB, da.fittsB, 0, 2000, "advanced.fittsB"),
      curveAmount: num(a.curveAmount, da.curveAmount, 0, 4, "advanced.curveAmount"),
      tremorAmplitude: num(a.tremorAmplitude, da.tremorAmplitude, 0, 6, "advanced.tremorAmplitude"),
      overshootChance: num(a.overshootChance, da.overshootChance, 0, 1, "advanced.overshootChance"),
      subMoveCount: int(a.subMoveCount, da.subMoveCount, 0, 3, "advanced.subMoveCount"),
      sampleRateHz: num(a.sampleRateHz, da.sampleRateHz, 30, 240, "advanced.sampleRateHz"),

      dwellBuckets: validateBuckets(a.dwellBuckets, da.dwellBuckets),
      breakEvery: int(a.breakEvery, da.breakEvery, 1, 1000, "advanced.breakEvery"),
      breakMinSec: int(a.breakMinSec, da.breakMinSec, 1, 3600, "advanced.breakMinSec"),
      breakMaxSec: int(a.breakMaxSec, da.breakMaxSec, 1, 7200, "advanced.breakMaxSec"),

      segmentVarianceSigma: num(a.segmentVarianceSigma, da.segmentVarianceSigma, 0, 4, "advanced.segmentVarianceSigma"),
      idleLimitSec: int(a.idleLimitSec, da.idleLimitSec, 30, 3600, "advanced.idleLimitSec"),
      appCooldownMinutes: int(a.appCooldownMinutes, da.appCooldownMinutes, 0, 240, "advanced.appCooldownMinutes"),

      personalitySeed: typeof a.personalitySeed === "string" ? a.personalitySeed : da.personalitySeed,

      keyAllowlist: Array.isArray(a.keyAllowlist) ? a.keyAllowlist : da.keyAllowlist,
      safeZonePaddingPx: int(a.safeZonePaddingPx, da.safeZonePaddingPx, 0, 400, "advanced.safeZonePaddingPx"),
      scrollDevice: oneOf(a.scrollDevice, da.scrollDevice, ["trackpad", "mouse"], "advanced.scrollDevice"),
    },
  };

  if (cfg.advanced.breakMaxSec < cfg.advanced.breakMinSec) {
    throw new Error("advanced.breakMaxSec must be >= advanced.breakMinSec");
  }
  return cfg;
}

/** Target active minutes per 10-minute segment for the configured busy level. */
export function targetMinutes(cfg) {
  if (cfg.busyLevel === "custom") return (cfg.customBusyPercent / 100) * 10;
  return BUSY_LEVELS[cfg.busyLevel];
}

export function load(file = SETTINGS_PATH) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      throw new Error(`settings.json is not readable: ${e.message}`);
    }
    // No file yet — first run. `running` defaults to false, so nothing moves
    // until the user presses Start.
  }
  return validate(raw);
}

export function save(cfg, file = SETTINGS_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename: the run loop re-reads this file every pass, and a partial
  // write would be a parse error that reverts settings to defaults mid-day.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(validate(cfg), null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Create settings.json on first run, defaults and all.
 *
 * Written out rather than left implicit so the file the UI points at actually
 * exists and can be hand-edited — the advanced block is only discoverable if it
 * is sitting there to be found.
 */
export function ensureSettings(file = SETTINGS_PATH) {
  if (fs.existsSync(file)) return false;
  save(DEFAULTS, file);
  return true;
}

/**
 * Copy the bundled scripts into the user's scripts folder, once.
 *
 * Only fills gaps — a script the user has edited is never overwritten, and one
 * they deleted stays deleted rather than reappearing on the next launch.
 */
export function ensureScripts(from, dir = SCRIPTS_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  let copied = 0;
  try {
    for (const name of fs.readdirSync(from)) {
      if (!name.endsWith(".js")) continue;
      const target = path.join(dir, name);
      if (fs.existsSync(target)) continue;
      fs.copyFileSync(path.join(from, name), target);
      copied++;
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return copied;
}

/** Installed scripts, for the picker. */
export function listScripts(dir = SCRIPTS_DIR) {
  try {
    return fs.readdirSync(dir)
      .filter((n) => n.endsWith(".js"))
      .map((n) => {
        const src = fs.readFileSync(path.join(dir, n), "utf8");
        const name = /@name\s+(.+)/.exec(src)?.[1]?.trim();
        const description = /@description\s+(.+)/.exec(src)?.[1]?.trim();
        return { file: n, id: n.replace(/\.js$/, ""), name: name || n, description };
      });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
