// A stable behavioural profile for this machine.
//
// Ported from click-stream/phone/src/personality.ts, keyed on hostname rather
// than account name. DETERMINISTIC on purpose — no Math.random anywhere in here.
// A real person's pace is consistent day to day; resampling a new "person" on
// every restart would make the pattern across a week less humanlike, not more.

import os from "node:os";

/** djb2 string hash -> unsigned 32-bit. */
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** Deterministic value in [0,1) from a seed + salt, xorshift-mixed so each trait
 *  varies independently instead of moving together. */
function unit(seed, salt) {
  let x = (seed ^ ((salt * 0x9e3779b1) >>> 0)) >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  return (x >>> 0) / 4294967296;
}

const lerp = (u, lo, hi) => lo + u * (hi - lo);

/**
 * Traits for this install. Same machine -> same profile, every run.
 *
 * @param {string} seed  Override for the hostname; "" derives from the machine.
 */
export function personalityFor(seed = "") {
  const key = seed || os.hostname() || "default";
  const h = hashStr(key);
  return {
    key,
    // Multiplies stroke durations and gaps: some people move deliberately.
    paceMult: lerp(unit(h, 1), 0.75, 1.5),
    // Multiplies dwell times between actions.
    dwellMult: lerp(unit(h, 2), 0.7, 1.4),
    // Nudges the activity target up or down. Kept narrow — this shifts the
    // number the user actually asked for, so it should season, not override.
    busyMult: lerp(unit(h, 3), 0.92, 1.08),
    // How much they taper toward the end of a session.
    endTaper: lerp(unit(h, 6), 0.05, 0.20),
    // Fixed offset so two machines never pick the same minutes in a segment.
    phase: unit(h, 7),
  };
}

/**
 * Multiplier on the activity target, as a function of how far into the session
 * you are.
 *
 * Anchored to the session rather than to the clock. It used to key off time of
 * day, which only made sense while a fixed work-hours window existed; with
 * sessions that start whenever Start is pressed, a 9am curve applied to a 3pm
 * session produced a shape that had nothing to do with the run.
 *
 * @param {object} p         personality
 * @param {number} elapsed   minutes since the session began
 * @param {number|null} total  session length in minutes, or null if open-ended
 */
export function busyShapeAt(p, elapsed, total = null) {
  // A brief settling-in, and no more than that.
  //
  // This used to start at 0.35 and take 40 minutes to reach full pace, which was
  // sized for an eight-hour work-hours day. Against a session you start and
  // watch, it meant "busy" planned three active minutes out of ten for the first
  // stretch — a third of what was asked for, arriving as multi-minute silences.
  // The setting has to mean what it says within a minute or two of starting.
  const warmUp = Math.min(1, 0.85 + Math.max(elapsed, 0) / 60);

  // Slow, low-frequency drift so a long session is not a flat line. Seeded from
  // the personality, so it is the same wave for this machine every time.
  const drift = 1 + 0.12 * Math.sin((elapsed / 47) + p.phase * Math.PI * 2);

  // Taper over the final fifth, but only when there is a known end to taper to.
  const t = total ? Math.min(Math.max(elapsed / total, 0), 1) : 0;
  const taper = total ? 1 - p.endTaper * Math.max(0, (t - 0.8) / 0.2) : 1;

  return Math.max(0.25, warmUp * drift * taper * p.busyMult);
}

const shapeMeanCache = new Map();

/**
 * Average of busyShapeAt across a session.
 *
 * The shape function mostly attenuates — warm-up and the end taper both pull
 * below 1 — so using it raw makes the configured busy level a ceiling that is
 * never reached, and "normal, 60%" quietly delivers 55%. Dividing by this mean
 * makes the setting the average the user actually gets while keeping the arc.
 */
export function dayShapeMean(p, total = null) {
  // Open-ended sessions are averaged over a nominal eight hours; the curve is
  // flat enough past the warm-up that the exact horizon barely moves the mean.
  const span = total ?? 8 * 60;
  const key = `${p.key}|${span}|${total == null ? "open" : "fixed"}`;
  const hit = shapeMeanCache.get(key);
  if (hit != null) return hit;

  let sum = 0, n = 0;
  for (let m = 0; m < span; m += 10) {
    sum += busyShapeAt(p, m, total);
    n++;
  }
  const mean = n ? sum / n : 1;
  shapeMeanCache.set(key, mean);
  return mean;
}

/** One-line summary for logs. */
export function summarize(p) {
  const r = (n) => Math.round(n * 100) / 100;
  return `pace×${r(p.paceMult)} dwell×${r(p.dwellMult)} busy×${r(p.busyMult)}`;
}
