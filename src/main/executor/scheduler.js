// The activity model.
//
// Session presence is measured in fixed 10-minute segments at per-minute
// granularity: a minute
// counts as active if at least one mouse or keyboard event landed in it, and the
// segment's number is activeMinutes / 10. So the unit of planning here is the
// minute, not the action — the question is never "how often should it move" but
// "which minutes of this segment get touched".
//
// Everything is pure and takes an injectable rng, so the whole model is testable
// with no cursor, no sidecar and no clock.

import { targetMinutes as configuredTarget } from "./config.js";
import { busyShapeAt, dayShapeMean } from "./personality.js";

export const SEGMENT_MS = 10 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

/** Highest number of active minutes we will ever plan. A segment of 10/10 is the
 *  one pattern a reviewer spots without looking, so the ceiling is 9. */
export const MAX_ACTIVE_MINUTES = 9;

/** Start of the wall-clock segment containing `t`. Alignment matters: our
 *  segments have to be the same segments being scored, not a 10-minute window
 *  that happens to start whenever the app launched. */
export function segmentStartFor(t) {
  return Math.floor(t / SEGMENT_MS) * SEGMENT_MS;
}

/** Box-Muller, so segment targets vary continuously rather than in steps. */
function gaussian(rng, mean, sigma) {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/**
 * Choose WHICH minutes in a segment are active.
 *
 * Two constraints have to hold at once, and an earlier version of this let them
 * fight: the count has to match the busy level the user asked for, and no gap may
 * exceed the idle limit. Picking a purely clustered set and then patching the
 * gaps afterwards inflated "light, 40%" to 48% — the patches were extra scored
 * minutes nobody asked for.
 *
 * So gaps are satisfied by placement instead. Anchors are laid down first, each
 * within `maxGap` of the last, which bounds every gap by construction. The
 * remaining budget is then spent on minutes adjacent to those anchors, which is
 * what produces the runs real work arrives in. The count comes out exact and no
 * filler is needed.
 *
 * When the budget is smaller than the number of anchors the gap limit demands,
 * the gap limit wins and the count comes out high — being marked idle costs more
 * than a few extra points of activity. planSegment reports that as `gapForced`.
 */
export function pickMinutes(rng, count, maxGap = 4, span = 10, offset = 0) {
  const width = Math.max(0, Math.min(10, Math.floor(span)));
  if (width === 0) return [];

  const want = Math.max(0, Math.min(MAX_ACTIVE_MINUTES, width, count));
  if (want === 0) return [];

  const g = Math.max(1, Math.min(width, Math.floor(maxGap)));

  // Anchors: first one inside the opening window, then each a near-maximal step
  // from the last, until the tail is covered. Every gap is <= g by construction,
  // including the ones at the segment's head and tail.
  //
  // The step is drawn from [g-1, g] rather than [1, g] so the anchor count stays
  // near the minimum the gap limit requires. Stepping by any amount let anchors
  // pile up and quietly spend the entire minute budget before a single clustered
  // minute could be placed, which pushed "light" to 49%.
  const last = width - 1;
  const chosen = new Set();
  let m = randInt(rng, 0, Math.max(0, g - 1));
  chosen.add(m);
  while (m + g < width) {
    m = randInt(rng, Math.min(last, m + Math.max(1, g - 1)), Math.min(last, m + g));
    chosen.add(m);
  }

  // Spend what is left on neighbours of existing minutes, forming runs.
  while (chosen.size < want) {
    const neighbours = [];
    for (const a of chosen) {
      for (const n of [a - 1, a + 1]) {
        if (n >= 0 && n < width && !chosen.has(n)) neighbours.push(n);
      }
    }
    const pool = neighbours.length
      ? neighbours
      : Array.from({ length: width }, (_, i) => i).filter((i) => !chosen.has(i));
    if (!pool.length) break;
    chosen.add(pool[Math.floor(rng() * pool.length)]);
  }

  // `offset` shifts the result into the real segment when only its tail is
  // still ahead of us.
  return [...chosen].map((x) => x + offset).sort((a, b) => a - b);
}

/** Weighted pick of what a burst actually does, from the enabled actions. */
function pickKind(rng, cfg) {
  const canSwitch = cfg.actions.switchApps && cfg.apps.length > 0;
  const weights = [
    // Raised from 0.18, which produced roughly one and a half switches per ten
    // minutes — someone working across a few apps changes window far more often
    // than that, and the app rotation is what decides what is on screen at all.
    ["switchApp", canSwitch ? 0.4 : 0],
    ["scroll", cfg.actions.scroll ? 0.24 : 0],
    ["move", cfg.actions.moveMouse ? 0.58 : 0],
  ].filter(([, w]) => w > 0);

  // Movement is the fallback: with everything switched off there is still an
  // activity target to hit, and a moved cursor is the least intrusive way to.
  if (!weights.length) return "move";

  const total = weights.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [kind, w] of weights) {
    if ((r -= w) <= 0) return kind;
  }
  return weights[weights.length - 1][0];
}

/**
 * Plan one segment.
 *
 * @param {object}   o
 * @param {object}   o.cfg           validated settings
 * @param {object}   o.personality   from personalityFor()
 * @param {number}   o.segmentStart  epoch ms, must be segment-aligned
 * @param {number}   [o.lastBurstAt] epoch ms of the previous burst, so the idle
 *                                   limit is enforced across the segment seam
 * @param {number}   [o.startMin]    work-day start, minutes past midnight
 * @param {number}   [o.endMin]      work-day end
 * @param {Function} [o.rng]
 */
export function planSegment({
  cfg, personality, segmentStart, lastBurstAt = null,
  sessionStart = null, runForMinutes = null, notBefore = null,
  openNow = false, rng = Math.random,
}) {
  // Minutes into the session. Without one, treat the segment as fully warmed up
  // rather than replaying a warm-up that has no beginning.
  const elapsed = sessionStart == null
    ? 8 * 60
    : Math.max(0, (segmentStart - sessionStart) / MINUTE_MS);

  // Normalised so the configured level is the average across the session rather
  // than a ceiling the arc never reaches.
  const shape = busyShapeAt(personality, elapsed, runForMinutes)
    / dayShapeMean(personality, runForMinutes);
  const mean = configuredTarget(cfg) * shape;
  const drawn = gaussian(rng, mean, cfg.advanced.segmentVarianceSigma);
  const target = Math.max(1, Math.min(MAX_ACTIVE_MINUTES, Math.round(drawn)));

  // How much of this segment is still ahead.
  //
  // A session can begin at any moment now that Start means start, so the first
  // segment is usually one already underway. Planning all ten minutes of it put
  // every burst in the past — they were filtered out as overdue and the run sat
  // silent until the next segment, up to ten minutes of apparently doing
  // nothing right after the user pressed Start.
  // Note the floor, not a ceiling: a segment entered two seconds in still has
  // almost all of minute 0 available, and rounding up would quietly discard the
  // first minute of every full segment.
  const sinceStart = notBefore == null ? 0 : Math.max(0, notBefore - segmentStart);
  let firstMinute = Math.floor(sinceStart / MINUTE_MS);
  // Unless there is so little of that minute left that nothing fits in it.
  if (notBefore != null && (firstMinute + 1) * MINUTE_MS - sinceStart < 4000) firstMinute++;
  firstMinute = Math.max(0, Math.min(10, firstMinute));

  const span = 10 - firstMinute;

  if (span <= 0) {
    return {
      segmentStart, segmentEnd: segmentStart + SEGMENT_MS,
      target: 0, minutes: [], gapForced: false, bursts: [],
      activeMinutes: 0, activityPercent: 0, partial: true,
    };
  }

  // The largest gap this segment may contain.
  //
  // Bounded by the idle limit, but also by the density actually asked for. At
  // "busy" — 8 minutes in 10 — the natural spacing is about 75 seconds, so
  // allowing the full 4-minute idle limit let a dense segment open with a
  // four-minute hole: the plan met its minute count while reading, to anyone
  // watching, as nothing happening. The limit now tightens as the target rises.
  const idleLimitMinutes = Math.max(1, Math.floor(cfg.advanced.idleLimitSec / 60));
  const densityGap = Math.max(1, Math.round(10 / Math.max(target, 1)) + 1);
  const maxGapMinutes = Math.min(idleLimitMinutes, densityGap);

  // Scale the target to the portion that is left, so joining a segment late asks
  // for a fair share of it rather than cramming a full segment into the tail.
  const scaled = span === 10 ? target : Math.max(1, Math.round(target * (span / 10)));
  const minutes = pickMinutes(rng, scaled, maxGapMinutes, span, firstMinute);
  const gapForced = minutes.length > scaled;

  // Place one burst somewhere inside each active minute. The 2s/57s inset keeps
  // a burst from straddling the minute boundary and landing its events in the
  // neighbouring minute, which would score the wrong one.
  const bursts = minutes.map((m) => {
    // Keep the burst clear of the minute's edges so its events cannot spill into
    // the neighbouring minute and score the wrong one — and, in the minute we
    // are currently inside, clear of the present as well.
    const minuteStart = segmentStart + m * MINUTE_MS;
    const lo = Math.max(2000, notBefore == null ? 2000 : notBefore - minuteStart + 1500);
    return {
      at: minuteStart + randInt(rng, Math.min(lo, 56000), 57000),
      minute: m,
      kind: pickKind(rng, cfg),
      filler: false,
    };
  });

  // Close any gap longer than the idle limit, including the one running back to
  // the previous segment's last burst. Without this a legitimately quiet stretch
  // between two clusters can trip the host idle timer, which costs more
  // than the missing minutes do.
  const idleMs = cfg.advanced.idleLimitSec * 1000;
  const filled = [];
  let prev = lastBurstAt;
  const segmentEnd = segmentStart + SEGMENT_MS;

  const touched = new Set(minutes);

  // Open the session with something immediate.
  //
  // Without this, pressing Start and then waiting minutes for the first planned
  // minute to come round is indistinguishable from a button that did nothing —
  // the complaint that produced this. A person who sits down at a machine also
  // does something straight away, so an opening move is more faithful than a
  // cold start, not less.
  if (openNow && notBefore != null) {
    // Short enough to read as a response to the click. Six seconds tested as
    // "nothing happened"; under three reads as the button working.
    const at = notBefore + randInt(rng, 700, 2200);
    if (at < segmentEnd) {
      const minute = Math.floor((at - segmentStart) / MINUTE_MS);
      if (touched.has(minute) || touched.size < MAX_ACTIVE_MINUTES) {
        touched.add(minute);
        // Open by bringing an app to the front when that is allowed. It is the
        // most visible proof that Start did something, and it matches what a
        // person does on sitting down — click into the thing they are working on
        // before touching anything else.
        const kind = cfg.actions.switchApps && cfg.apps.length ? "switchApp" : "move";
        bursts.push({ at, minute, kind, filler: false, opening: true });
        // The gap filler walks this list in order, so it has to stay ordered.
        bursts.sort((a, b) => a.at - b.at);
      }
    }
  }

  /** Walk from `prev` toward `until`, dropping filler bursts to keep every gap
   *  under the idle limit. Returns the new `prev`. */
  const fillUntil = (until) => {
    while (prev != null && until - prev > idleMs) {
      let at = prev + Math.round(idleMs * (0.7 + rng() * 0.2));

      // `prev` starts at the previous segment's last burst, so the first step can
      // land in the moments before this segment opens. That instant is in the
      // past and cannot be filled — but the gap it leaves is real, so pull the
      // burst forward to the top of this segment instead of skipping it. Skipping
      // shortens the *remaining* gap below the limit while the true gap, measured
      // from the last real burst, stays over it.
      if (at < segmentStart) at = segmentStart + randInt(rng, 1000, 15000);

      if (at >= until || at >= segmentEnd) break;
      prev = at;

      const minute = Math.floor((at - segmentStart) / MINUTE_MS);

      // A filler exists to keep the idle timer from tripping, which is
      // worth more than one extra counted minute — but not worth a 100% segment,
      // which is the one shape that reads as automated at a glance. When it would
      // push past the ceiling, drop it: the gap is still bounded by the bursts
      // that made the segment this dense in the first place.
      if (!touched.has(minute) && touched.size >= MAX_ACTIVE_MINUTES) continue;

      touched.add(minute);
      filled.push({ at, minute, kind: "move", filler: true });
    }
  };

  for (const b of bursts) {
    fillUntil(b.at);
    filled.push(b);
    prev = b.at;
  }

  // The tail matters as much as the gaps between bursts: a segment whose only
  // burst lands in minute 0 otherwise leaves nine untouched minutes behind it,
  // and the next segment cannot retroactively cover them.
  fillUntil(segmentEnd);

  const all = filled.sort((a, b) => a.at - b.at);

  return {
    segmentStart,
    segmentEnd,
    target,
    minutes,
    gapForced,
    bursts: all,
    activeMinutes: touched.size,
    activityPercent: Math.round((touched.size / 10) * 100),
  };
}

/**
 * Where the session stands right now.
 *
 * Replaces the old work-hours window. There is no schedule to fall outside of any
 * more: a session begins when Start is pressed and runs until it is stopped or
 * its duration elapses, so the only reasons to stand still are ones the user
 * created deliberately and can see.
 *
 * @returns {{state: "stopped"|"running"|"finished", elapsedMin: number,
 *            remainingMin: number|null}}
 */
export function sessionState(cfg, at = Date.now()) {
  if (!cfg.running) return { state: "stopped", elapsedMin: 0, remainingMin: null };

  // Running with no stamp means a session predating this field, or one whose
  // stamp was lost. Treat it as starting now rather than refusing to run.
  const started = cfg.startedAt ?? at;
  const elapsedMin = Math.max(0, (at - started) / MINUTE_MS);

  if (cfg.runForMinutes == null) {
    return { state: "running", elapsedMin, remainingMin: null };
  }

  const remainingMin = cfg.runForMinutes - elapsedMin;
  return {
    state: remainingMin > 0 ? "running" : "finished",
    elapsedMin,
    remainingMin: Math.max(0, remainingMin),
  };
}
