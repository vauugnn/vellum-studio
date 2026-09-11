// The scheduler is the one component whose correctness cannot be seen by
// watching the cursor: a stroke that looks perfect still scores zero if it landed
// in a minute that was already counted. These tests assert the model itself.

import test from "node:test";
import assert from "node:assert/strict";

import { validate, MAX_BUSY_PERCENT } from "./config.js";
import { personalityFor } from "./personality.js";
import {
  planSegment, pickMinutes, segmentStartFor, sessionState,
  SEGMENT_MS, MINUTE_MS, MAX_ACTIVE_MINUTES,
} from "./scheduler.js";

/** Deterministic rng so a failure is reproducible rather than a coin flip. */
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const personality = personalityFor("test-machine");
const baseCfg = validate({
  busyLevel: "normal",
  apps: [{ bundleId: "com.apple.finder", name: "Finder" }],
});

/**
 * Walk consecutive segments of one continuous session, which is what the runner
 * now does — there is no schedule to skip around, so every segment is planned.
 */
function simulate(cfg, count = 500, rng = seeded(7)) {
  const start = segmentStartFor(new Date("2026-08-10T09:20:00").getTime());
  const out = [];
  let lastBurstAt = null;

  for (let i = 0; i < count; i++) {
    const segmentStart = start + i * SEGMENT_MS;
    const plan = planSegment({
      cfg, personality, segmentStart, lastBurstAt,
      sessionStart: start, runForMinutes: cfg.runForMinutes, rng,
    });
    lastBurstAt = plan.bursts.length ? plan.bursts[plan.bursts.length - 1].at : lastBurstAt;
    out.push(plan);
  }
  return out;
}

test("segments align to wall-clock 10-minute boundaries", () => {
  for (const t of [Date.now(), 0, new Date("2026-08-10T09:27:33.412Z").getTime()]) {
    assert.equal(segmentStartFor(t) % SEGMENT_MS, 0);
    assert.ok(segmentStartFor(t) <= t && t - segmentStartFor(t) < SEGMENT_MS);
  }
});

test("every burst lands inside the minute it is credited to", () => {
  for (const plan of simulate(baseCfg)) {
    for (const b of plan.bursts) {
      const offset = b.at - plan.segmentStart;
      assert.equal(Math.floor(offset / MINUTE_MS), b.minute,
        `burst at +${offset}ms credited to minute ${b.minute}`);
      assert.ok(offset >= 0 && offset < SEGMENT_MS, "burst escaped its segment");
    }
  }
});

test("activity tracks the configured busy level", () => {
  for (const [level, expected] of [["light", 40], ["normal", 60], ["busy", 80]]) {
    const cfg = validate({ busyLevel: level, apps: baseCfg.apps });
    const plans = simulate(cfg);
    const avg = plans.reduce((s, p) => s + p.activityPercent, 0) / plans.length;
    // The busy level is the average the user gets, not a ceiling — the session
    // curve is normalised so its arc redistributes activity without shrinking it.
    assert.ok(Math.abs(avg - expected) < 8,
      `${level}: average ${avg.toFixed(1)}% should sit near the configured ${expected}%`);
  }
});

test("no segment ever reads 100%", () => {
  for (const level of ["light", "normal", "busy"]) {
    const cfg = validate({ busyLevel: level, apps: baseCfg.apps });
    for (const plan of simulate(cfg)) {
      assert.ok(plan.activeMinutes <= MAX_ACTIVE_MINUTES,
        `${level} produced a ${plan.activityPercent}% segment`);
    }
  }
});

test("custom busy percent is capped", () => {
  assert.throws(() => validate({ busyLevel: "custom", customBusyPercent: 100 }),
    /customBusyPercent out of range/);
  const cfg = validate({ busyLevel: "custom", customBusyPercent: MAX_BUSY_PERCENT });
  for (const plan of simulate(cfg, 200)) {
    assert.ok(plan.activeMinutes <= MAX_ACTIVE_MINUTES);
  }
});

test("no gap between bursts exceeds the idle limit", () => {
  // "light" is the worst case: fewest planned minutes, so the gap filler is what
  // is actually keeping the stream continuous.
  const cfg = validate({ busyLevel: "light", apps: baseCfg.apps });
  const idleMs = cfg.advanced.idleLimitSec * 1000;
  const plans = simulate(cfg);

  for (let i = 1; i < plans.length; i++) {
    const stream = [...plans[i - 1].bursts, ...plans[i].bursts];
    for (let k = 1; k < stream.length; k++) {
      const gap = stream[k].at - stream[k - 1].at;
      // The filler steps at 70-90% of the limit and stops at the segment edge, so
      // a seam can run a little over before the next segment's first burst lands.
      assert.ok(gap <= idleMs * 1.3,
        `gap of ${Math.round(gap / 1000)}s exceeds the ${cfg.advanced.idleLimitSec}s idle limit ` +
        `(at ${new Date(stream[k - 1].at).toTimeString().slice(0, 8)})`);
    }
  }
});

test("minute patterns are not identical across segments", () => {
  const signatures = new Set(simulate(baseCfg).map((p) => p.minutes.join(",")));
  assert.ok(signatures.size > 40,
    `only ${signatures.size} distinct minute patterns across 500 segments — too regular`);
});

test("minutes arrive in runs rather than evenly spread", () => {
  // A clustered set has adjacent pairs; an evenly-spread one mostly does not.
  const rng = seeded(3);
  let adjacent = 0, trials = 400;
  for (let i = 0; i < trials; i++) {
    const m = pickMinutes(rng, 6);
    for (let k = 1; k < m.length; k++) if (m[k] - m[k - 1] === 1) adjacent++;
  }
  assert.ok(adjacent / trials > 1.5,
    `only ${(adjacent / trials).toFixed(2)} adjacent minutes per segment — not clustered`);
});

test("pickMinutes honours the requested count once the gap limit allows it", () => {
  const rng = seeded(11);
  const maxGap = 4;
  // Covering 10 minutes with no gap over 4 needs 3 anchors, so counts below that
  // cannot be honoured — the gap limit wins and the caller sees gapForced.
  const floorCount = Math.ceil(10 / maxGap);

  for (let want = 0; want <= MAX_ACTIVE_MINUTES; want++) {
    for (let i = 0; i < 200; i++) {
      const m = pickMinutes(rng, want, maxGap);
      assert.equal(new Set(m).size, m.length, "duplicate minutes");
      assert.ok(m.every((x) => x >= 0 && x < 10), "minute out of range");

      if (want === 0) assert.equal(m.length, 0);
      else if (want >= floorCount) assert.equal(m.length, want, `want ${want}`);
      else assert.ok(m.length >= want && m.length <= floorCount + 1, `want ${want} got ${m.length}`);
    }
  }
});

test("pickMinutes never leaves a gap over the limit", () => {
  const rng = seeded(13);
  for (const maxGap of [2, 3, 4, 5]) {
    for (let want = 1; want <= MAX_ACTIVE_MINUTES; want++) {
      for (let i = 0; i < 100; i++) {
        const m = pickMinutes(rng, want, maxGap);
        assert.ok(m[0] <= maxGap - 1, `head gap ${m[0]} exceeds ${maxGap}`);
        assert.ok(10 - m[m.length - 1] <= maxGap, "tail gap exceeds the limit");
        for (let k = 1; k < m.length; k++) {
          assert.ok(m[k] - m[k - 1] <= maxGap, `gap ${m[k] - m[k - 1]} exceeds ${maxGap}`);
        }
      }
    }
  }
});

test("burst kinds respect the action switches", () => {
  const cfg = validate({
    apps: baseCfg.apps,
    actions: { moveMouse: true, switchApps: false, scroll: false, pressKeys: false, click: false },
  });
  for (const plan of simulate(cfg, 200)) {
    for (const b of plan.bursts) assert.equal(b.kind, "move");
  }
});

test("movement is the fallback when every action is switched off", () => {
  const cfg = validate({
    apps: [],
    actions: { moveMouse: false, switchApps: false, scroll: false, pressKeys: false, click: false },
  });
  const plans = simulate(cfg, 100);
  assert.ok(plans.some((p) => p.bursts.length > 0), "planned nothing at all");
  for (const plan of plans) {
    for (const b of plan.bursts) assert.equal(b.kind, "move");
  }
});

test("switchApp is never planned without apps configured", () => {
  const cfg = validate({ apps: [], actions: { ...baseCfg.actions, switchApps: true } });
  for (const plan of simulate(cfg, 200)) {
    for (const b of plan.bursts) assert.notEqual(b.kind, "switchApp");
  }
});

test("starting mid-segment plans only the time still ahead", () => {
  // The bug this guards: a session begun at 14:48:29 planned segment 14:40 as if
  // all ten of its minutes were available, put every burst in the past, and then
  // sat silent until 14:50 — ten minutes of nothing right after pressing Start.
  const segmentStart = segmentStartFor(new Date("2026-08-10T14:40:00").getTime());

  for (const joinAtMin of [0, 1, 4, 7, 8.48, 9.5]) {
    const notBefore = segmentStart + joinAtMin * MINUTE_MS;
    const plan = planSegment({
      cfg: baseCfg, personality, segmentStart, notBefore,
      sessionStart: notBefore, rng: seeded(21),
    });

    for (const b of plan.bursts) {
      assert.ok(b.at > notBefore,
        `joined at +${joinAtMin}min but planned a burst ${Math.round((notBefore - b.at) / 1000)}s in the past`);
      assert.ok(b.at < plan.segmentEnd, "burst escaped its segment");
    }
  }
});

test("a full segment keeps its first minute", () => {
  // Entering a segment a second or two late is normal — the loop wakes just past
  // the boundary. Rounding that up to the next minute would drop minute 0 from
  // every segment for the life of the run.
  const segmentStart = segmentStartFor(new Date("2026-08-10T14:40:00").getTime());
  let sawMinuteZero = false;

  for (let i = 0; i < 60; i++) {
    const plan = planSegment({
      cfg: baseCfg, personality, segmentStart,
      notBefore: segmentStart + 1500, sessionStart: segmentStart,
      rng: seeded(100 + i),
    });
    if (plan.minutes.includes(0)) sawMinuteZero = true;
    assert.ok(plan.minutes.length > 0, "planned an empty segment two seconds in");
  }
  assert.ok(sawMinuteZero, "minute 0 never planned despite the segment being fresh");
});

test("joining with seconds to spare plans nothing rather than something impossible", () => {
  const segmentStart = segmentStartFor(new Date("2026-08-10T14:40:00").getTime());
  const plan = planSegment({
    cfg: baseCfg, personality, segmentStart,
    notBefore: segmentStart + SEGMENT_MS - 1000, sessionStart: segmentStart,
    rng: seeded(31),
  });
  assert.equal(plan.bursts.length, 0);
  assert.equal(plan.partial, true);
});

test("a session opens with a burst within seconds of starting", () => {
  // Start has to visibly do something. Waiting minutes for the first planned
  // minute to come round is indistinguishable from a button that did nothing.
  const segmentStart = segmentStartFor(new Date("2026-08-10T14:40:00").getTime());

  for (const joinAtMin of [0, 2.5, 5, 8.4]) {
    const notBefore = segmentStart + joinAtMin * MINUTE_MS;
    const plan = planSegment({
      cfg: baseCfg, personality, segmentStart, notBefore,
      sessionStart: notBefore, openNow: true, rng: seeded(77),
    });

    const first = plan.bursts[0];
    assert.ok(first, `no bursts at all when joining at +${joinAtMin}min`);
    const waitSec = (first.at - notBefore) / 1000;
    assert.ok(waitSec > 0 && waitSec <= 10,
      `first burst is ${waitSec.toFixed(1)}s after Start — should be within seconds`);
  }
});

test("the opener never pushes a segment past the activity ceiling", () => {
  const cfg = validate({ busyLevel: "busy", apps: baseCfg.apps });
  const segmentStart = segmentStartFor(new Date("2026-08-10T14:40:00").getTime());

  for (let i = 0; i < 200; i++) {
    const plan = planSegment({
      cfg, personality, segmentStart, notBefore: segmentStart + 500,
      sessionStart: segmentStart, openNow: true, rng: seeded(400 + i),
    });
    assert.ok(plan.activeMinutes <= MAX_ACTIVE_MINUTES,
      `opener produced a ${plan.activityPercent}% segment`);
  }
});

test("bursts stay in chronological order once an opener is added", () => {
  // The gap filler walks the burst list in order; an out-of-order opener would
  // make it insert fillers against the wrong neighbour.
  const segmentStart = segmentStartFor(new Date("2026-08-10T14:40:00").getTime());
  for (let i = 0; i < 50; i++) {
    const plan = planSegment({
      cfg: baseCfg, personality, segmentStart, notBefore: segmentStart + 1000,
      sessionStart: segmentStart, openNow: true, rng: seeded(700 + i),
    });
    for (let k = 1; k < plan.bursts.length; k++) {
      assert.ok(plan.bursts[k].at >= plan.bursts[k - 1].at, "bursts out of order");
    }
  }
});

test("app rotation keeps switching once every app is cooling down", () => {
  // The bug: two apps on a 12-minute cooldown meant nothing was ever available,
  // every switchApp burst silently degraded to a plain move, and the app never
  // visibly changed windows. Cooldowns must discourage a repeat, never starve
  // the rotation.
  const cooldown = new Map();
  const apps = [{ bundleId: "a", name: "A" }, { bundleId: "b", name: "B" }];
  const now = Date.now();
  // Both deep in cooldown.
  cooldown.set("a", now + 10 * 60_000);
  cooldown.set("b", now + 12 * 60_000);

  const pick = (current) => {
    let available = apps.filter((a) => (cooldown.get(a.bundleId) ?? 0) <= now);
    if (!available.length) {
      const byStalest = [...apps].sort(
        (x, y) => (cooldown.get(x.bundleId) ?? 0) - (cooldown.get(y.bundleId) ?? 0)
      );
      available = byStalest.filter((a) => a.name !== current);
      if (!available.length) available = byStalest;
    }
    return available[0] ?? null;
  };

  assert.ok(pick("A"), "returned nothing while every app was cooling");
  assert.equal(pick("A").name, "B", "should move to the app waiting longest");
  assert.equal(pick("B").name, "A");
});

test("a session with app switching on opens by switching", () => {
  const cfg = validate({
    apps: [{ bundleId: "com.apple.finder", name: "Finder" }],
    actions: { moveMouse: true, switchApps: true, scroll: true, pressKeys: false, click: false },
  });
  const segmentStart = segmentStartFor(new Date("2026-08-10T14:40:00").getTime());
  const plan = planSegment({
    cfg, personality, segmentStart, notBefore: segmentStart + 1000,
    sessionStart: segmentStart, openNow: true, rng: seeded(9),
  });
  assert.equal(plan.bursts[0].kind, "switchApp");
});

test("the opener falls back to a move when switching is off", () => {
  const cfg = validate({
    apps: [{ bundleId: "com.apple.finder", name: "Finder" }],
    actions: { moveMouse: true, switchApps: false, scroll: false, pressKeys: false, click: false },
  });
  const segmentStart = segmentStartFor(new Date("2026-08-10T14:40:00").getTime());
  const plan = planSegment({
    cfg, personality, segmentStart, notBefore: segmentStart + 1000,
    sessionStart: segmentStart, openNow: true, rng: seeded(9),
  });
  assert.equal(plan.bursts[0].kind, "move");
});

test("a level delivers what it promises from the first minute of a session", () => {
  // The warm-up used to start at 0.35 and take 40 minutes to reach full pace,
  // sized for an eight-hour day. On an on-demand session that meant "busy"
  // planned three minutes out of ten at the start — a third of what was asked
  // for — and the setting simply did not mean what it said.
  const start = segmentStartFor(new Date("2026-08-10T09:00:00").getTime());

  for (const [level, expected] of [["light", 40], ["normal", 60], ["busy", 80]]) {
    const cfg = validate({ busyLevel: level });
    // The opening segment, planned at session minute zero.
    const plan = planSegment({
      cfg, personality, segmentStart: start, sessionStart: start, rng: seeded(5),
    });
    assert.ok(Math.abs(plan.activityPercent - expected) <= 20,
      `${level} opened at ${plan.activityPercent}%, expected near ${expected}%`);
  }
});

test("denser levels are not allowed to leave long holes", () => {
  // A plan can hit its minute count and still read as nothing happening if it
  // clusters everything and leaves a four-minute gap. The gap ceiling tightens
  // as the requested density rises.
  const cfg = validate({ busyLevel: "busy" });
  const start = segmentStartFor(new Date("2026-08-10T10:00:00").getTime());

  const gaps = [];
  for (let i = 0; i < 300; i++) {
    const plan = planSegment({
      cfg, personality, segmentStart: start + i * SEGMENT_MS,
      sessionStart: start, rng: seeded(900 + i),
    });
    for (let k = 1; k < plan.minutes.length; k++) {
      gaps.push(plan.minutes[k] - plan.minutes[k - 1]);
    }
  }
  const longOnes = gaps.filter((g) => g >= 3).length / gaps.length;
  assert.ok(longOnes < 0.1,
    `${(longOnes * 100).toFixed(0)}% of gaps at "busy" are 3min or longer`);
});

test("a stopped session does nothing regardless of the clock", () => {
  const cfg = validate({ running: false });
  assert.equal(sessionState(cfg, Date.now()).state, "stopped");
  // The old work-hours gate could refuse at 3am on a Sunday. Nothing refuses now
  // except the switch itself, which is the whole point of the change.
  assert.equal(sessionState(cfg, new Date("2026-08-16T03:00:00").getTime()).state, "stopped");
});

test("an open-ended session runs from the moment it starts, forever", () => {
  const t0 = new Date("2026-08-10T03:00:00").getTime();
  const cfg = validate({ running: true, startedAt: t0, runForMinutes: null });

  for (const afterMin of [0, 1, 60, 60 * 24, 60 * 24 * 7]) {
    const s = sessionState(cfg, t0 + afterMin * 60_000);
    assert.equal(s.state, "running", `should still run ${afterMin}min in`);
    assert.equal(s.remainingMin, null);
  }
});

test("a timed session finishes exactly when its duration elapses", () => {
  const t0 = new Date("2026-08-10T09:00:00").getTime();
  const cfg = validate({ running: true, startedAt: t0, runForMinutes: 90 });

  assert.equal(sessionState(cfg, t0).state, "running");
  assert.equal(sessionState(cfg, t0 + 89 * 60_000).state, "running");
  assert.equal(sessionState(cfg, t0 + 90 * 60_000).state, "finished");
  assert.equal(sessionState(cfg, t0 + 200 * 60_000).state, "finished");

  assert.equal(Math.round(sessionState(cfg, t0 + 30 * 60_000).remainingMin), 60);
  assert.equal(sessionState(cfg, t0 + 200 * 60_000).remainingMin, 0);
});

test("running without a start stamp begins now rather than refusing", () => {
  // Settings written before startedAt existed, or a stamp lost some other way.
  // Refusing to run would be a silent dead end of exactly the kind this model
  // was meant to remove.
  const cfg = validate({ running: true, startedAt: null, runForMinutes: 60 });
  const s = sessionState(cfg, Date.now());
  assert.equal(s.state, "running");
  assert.equal(Math.round(s.remainingMin), 60);
});

test("elapsed time drives the activity curve, not the time of day", () => {
  // The same session minute must plan the same way whether it falls at 9am or
  // 3am — there is no longer any such thing as a good or bad hour to run.
  const cfg = validate({ busyLevel: "normal" });
  const shapeAt = (iso) => {
    const start = segmentStartFor(new Date(iso).getTime());
    return planSegment({
      cfg, personality, segmentStart: start + 30 * 60_000,
      sessionStart: start, runForMinutes: null, rng: seeded(5),
    }).target;
  };
  assert.equal(shapeAt("2026-08-10T09:00:00"), shapeAt("2026-08-11T03:00:00"));
});
