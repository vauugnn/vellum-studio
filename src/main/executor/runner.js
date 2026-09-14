// The orchestrator.
//
// One persistent loop, in the shape of click-stream/phone/src/main.ts: it stays
// running whether or not it is currently allowed to act, re-reads its settings
// each pass, and does nothing loudly rather than exiting when gated out. Start and
// stop are settings, not process lifecycle.
//
// Runs headless (`node src/main/executor/runner.js`) or inside an Electron
// utilityProcess. Nothing in here imports Electron.

import path from "node:path";

import { load, SETTINGS_PATH, SCRIPTS_DIR } from "./config.js";
import { personalityFor, summarize } from "./personality.js";
import {
  planSegment, segmentStartFor, sessionState, SEGMENT_MS, MINUTE_MS,
} from "./scheduler.js";

import { Device } from "./device.js";
import { Script, buildContext } from "./sandbox.js";
import * as logger from "./log.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const chance = (p) => Math.random() < p;

/** Thrown into an in-flight burst when the user takes over. */
class Yielded extends Error {}

export class Runner {
  #device = null;
  #stopping = false;
  #pausedUntil = 0;
  #appCooldown = new Map();   // bundleId -> epoch ms until usable again
  #leftAt = new Map();        // bundleId -> epoch ms we last switched away from it
  #currentApp = null;
  #burstsSinceBreak = 0;
  // null | "stopped" — why nothing is happening, when nothing is
  #gate = "stopped";

  #loadedScriptPath = undefined;
  #sessionOpened = false;

  /**
   * @param {object} o
   * @param {string} [o.settingsPath]
   * @param {object} [o.overrides]  Shallow-merged over settings after every
   *   reload. The loop re-reads the file each pass, so anything set once in the
   *   constructor would otherwise be erased on the very next tick.
   */
  constructor({
    settingsPath = SETTINGS_PATH, overrides = {}, scriptPath = null, onState = () => {},
  } = {}) {
    this.settingsPath = settingsPath;
    this.overrides = overrides;
    this.onState = onState;
    this.cfg = this.#loadSettings();
    this.personality = personalityFor(this.cfg.advanced.personalitySeed);
    // An explicit path wins (the headless SCRIPT= entry); otherwise the script
    // named in settings is resolved out of the user's scripts folder.
    this.scriptPath = scriptPath;
    this.script = null;
    this.#syncScript();
  }

  #loadSettings() {
    return { ...load(this.settingsPath), ...this.overrides };
  }

  get state() {
    return {
      running: !this.#stopping,
      paused: Date.now() < this.#pausedUntil,
      pausedUntil: this.#pausedUntil,
      currentApp: this.#currentApp,
      gate: this.#gate,
    };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    await this.startDeviceOnly();
    return this.#loop();
  }

  /**
   * Bring up the sidecar and hand back, without entering the run loop.
   *
   * Split out so the diagnostics can drive a live device without the scheduler
   * also running underneath them and fighting for the cursor.
   */
  async startDeviceOnly() {
    this.#device = new Device();
    this.#device.on("stderr", (t) => logger.warn(`sidecar: ${t}`));
    this.#device.on("log", (m) => logger.log(m.level ?? "info", m.msg));
    this.#device.on("crashed", ({ code, signal }) =>
      logger.error(`sidecar died (code ${code}, signal ${signal})`));
    this.#device.on("humanInput", (m) => this.#onHumanInput(m));

    this.#device.start();

    const caps = await this.#device.require("caps", {
      prompt: false,
    });

    logger.info(
      `sidecar v${caps.version} — accessibility ${caps.trusted ? "granted" : "MISSING"}, ` +
      `guard ${caps.guard ? "armed" : "unavailable"}`
    );
    if (!caps.trusted) {
      logger.error("Accessibility is not granted — no input will reach the system.");
    }
    logger.info(`personality: ${summarize(this.personality)}`);

    // Always armed. Real input must always win over the schedule.
    await this.#device.call("guard", { on: true });
  }

  async stop() {
    this.#stopping = true;
    await this.#device?.stop();
  }

  /** Running applications, for the settings panel's app picker. */
  async listApps() {
    if (!this.#device?.running) return [];
    const res = await this.#device.call("apps.list");
    return res.apps ?? [];
  }

  // ── diagnostics ───────────────────────────────────────────────────────────

  /**
   * Exercise every layer and report what each one actually produced.
   *
   * Deliberately reports numbers rather than pass/fail alone. The interesting
   * question about this app is not "did the call succeed" but "is the output
   * different every time" — a stroke that always takes 1200ms and 110 samples is
   * a working call and a broken feature. So the variation checks report their
   * spread and let you see it.
   *
   * @param {object}   o
   * @param {Function} [o.onStep]  called with each result as it completes
   */
  async selfTest({ onStep = () => {} } = {}) {
    const results = [];

    const step = async (name, fn) => {
      const started = Date.now();
      let result;
      try {
        const data = await fn();
        result = { name, ok: true, ms: Date.now() - started, ...data };
      } catch (e) {
        result = { name, ok: false, ms: Date.now() - started, detail: e.message };
      }
      results.push(result);
      onStep(result);
      return result;
    };

    {
      await step("Sidecar", async () => {
        const caps = await this.#device.require("caps");
        return {
          detail: `v${caps.version}, ${caps.screens.length} display(s)`,
          data: caps.screens.map((s) => `${Math.round(s.w)}×${Math.round(s.h)} @${s.scale}x`),
        };
      });

      await step("Accessibility", async () => {
        const caps = await this.#device.require("caps");
        if (!caps.trusted) throw new Error("not granted — nothing will reach the system");
        return { detail: "granted" };
      });

      await step("Human-input guard", async () => {
        const caps = await this.#device.require("caps");
        if (!caps.guard) throw new Error("event tap unavailable");
        return { detail: "armed — real input will pause the run" };
      });

      await step("Running apps", async () => {
        const apps = await this.listApps();
        if (!apps.length) throw new Error("none found");
        return { detail: `${apps.length} found`, data: apps.slice(0, 6).map((a) => a.name) };
      });

      await step("Your app list", async () => {
        if (!this.cfg.apps.length) throw new Error("no apps chosen yet");
        const rows = [];
        for (const app of this.cfg.apps) {
          const w = await this.#device.call("apps.frontWindow", { bundleId: app.bundleId });
          rows.push(
            w.ok === false || !w.rect
              ? `${app.name}: ${w.error ?? "no window"}`
              : `${app.name}: ${Math.round(w.rect.w)}×${Math.round(w.rect.h)} at ` +
                `${Math.round(w.rect.x)},${Math.round(w.rect.y)}`
          );
        }
        return { detail: `${this.cfg.apps.length} configured`, data: rows };
      });

      // The scheduler is pure, so this plans against the real settings without
      // touching the clock or the cursor.
      await step("Schedule variation", async () => {
        const rows = [];
        const seen = new Set();
        let base = segmentStartFor(Date.now());
        for (let i = 0; i < 6; i++) {
          const plan = planSegment({
            cfg: this.cfg,
            personality: this.personality,
            segmentStart: base + i * SEGMENT_MS,
            sessionStart: this.cfg.startedAt,
          });
          seen.add(plan.minutes.join(","));
          rows.push(
            `${new Date(plan.segmentStart).toTimeString().slice(0, 5)}  ` +
            `${String(plan.activityPercent).padStart(3)}%  minutes ${plan.minutes.join(",")}`
          );
        }
        if (seen.size < 3) {
          throw new Error(`only ${seen.size} distinct patterns in 6 segments — too regular`);
        }
        return { detail: `${seen.size} distinct patterns across 6 segments`, data: rows };
      });

      await step("Movement variation", async () => {
        const rows = [];
        const durations = [];
        const screens = (await this.#device.require("caps")).screens;
        const s = screens[0];

        for (let i = 0; i < 5; i++) {
          const x = s.x + randInt(80, Math.max(81, Math.floor(s.w) - 80));
          const y = s.y + randInt(80, Math.max(81, Math.floor(s.h) - 80));
          const r = await this.#device.call(
            "mouse.moveTo", { x, y, ...this.#moveOptions() }, { timeoutMs: 20_000 }
          );
          durations.push(r.actualMs);
          rows.push(
            `→ ${String(Math.round(x)).padStart(4)},${String(Math.round(y)).padStart(4)}  ` +
            `${String(Math.round(r.actualMs)).padStart(4)}ms  ${String(r.samples).padStart(3)} samples`
          );
        }

        // Identical timings would mean the humanization is not running at all.
        const spread = Math.max(...durations) - Math.min(...durations);
        if (spread < 40) {
          throw new Error(`durations vary by only ${Math.round(spread)}ms — not humanized`);
        }
        return {
          detail: `${Math.round(spread)}ms spread across 5 strokes`,
          data: rows,
        };
      });

      await step("Scroll", async () => {
        await this.#device.require("scroll", { dy: -3, ms: 300 });
        return { detail: "3 lines down" };
      });

      await step("Click safety", async () => {
        // Never actually clicks. It asks the sidecar whether an uncovered patch
        // of desktop exists, which is the check that gates every real click.
        const r = await this.#device.call("safePoint", {
          padding: this.cfg.advanced.safeZonePaddingPx,
        });
        return r.ok
          ? { detail: `safe area found at ${Math.round(r.x)},${Math.round(r.y)}` }
          : { detail: "screen fully covered — clicks would be refused", ok: true };
      });

      await step("Personality", async () => ({
        detail: summarize(this.personality),
        data: [`seeded from "${this.personality.key}" — identical on every run`],
      }));
    }

    return results;
  }

  /**
   * Run the real behaviour, now, so it can be watched.
   *
   * Same calls the scheduler makes during a shift — activate, move inside the
   * window, dwell, scroll — with the waiting removed. The schedule is what makes
   * this invisible over a day and unwatchable over a minute, so the demo skips it
   * and does the actions back to back.
   *
   */
  async demo({ rounds = 2, onStep = () => {} } = {}) {
    const say = (msg, data) => onStep({ name: msg, ok: true, ms: 0, data });
    let moves = 0;

    /**
     * Block until the user has been still for `resumeAfterSeconds`, then carry
     * on. Yielding is not quitting: during a shift the run pauses while you work
     * and picks back up once you stop, so the demo has to do the same or it is
     * showing the wrong behaviour.
     */
    const waitOutPause = async (why) => {
      if (!this.#paused) return;
      say(why);
      while (this.#paused && !this.#stopping) await sleep(250);
      if (!this.#stopping) say(`Picked back up after ${this.cfg.resumeAfterSeconds}s of quiet`);
    };

    try {
      const apps = this.cfg.apps;
      say(
        apps.length
          ? `Starting — ${apps.length} app${apps.length > 1 ? "s" : ""}, ${rounds} rounds`
          : "Starting — no apps configured, moving around the screen instead"
      );

      // Clicking the button is itself real input, so the guard is already holding
      // when we get here. Wait it out rather than reporting it as an interruption.
      await waitOutPause(
        `Waiting — clicking that button counts as you using the computer ` +
        `(${this.cfg.resumeAfterSeconds}s)`
      );

      for (let round = 1; round <= rounds; round++) {
        const targets = apps.length ? apps : [null];

        for (const app of targets) {
          if (this.#stopping) return;
          await waitOutPause("You took over — holding off");

          let rect = null;
          if (app) {
            const res = await this.#device.call("apps.activate", { bundleId: app.bundleId });
            if (res.ok === false) {
              say(`${app.name}: ${res.error} — skipping`);
              continue;
            }
            say(`Brought ${app.name} to the front`);

            const w = await this.#device.call("apps.frontWindow", { bundleId: app.bundleId });
            rect = w.ok === false ? null : w.rect;
            if (!rect) say(`${app.name} has no readable window — moving on screen instead`);
          }

          // Two or three moves inside the window, the way it behaves when it
          // settles somewhere for a stretch.
          for (let i = 0; i < randInt(2, 3); i++) {
            if (this.#stopping) return;
            await waitOutPause("You took over — holding off");

            const r = rect
              ? await this.#device.call(
                  "mouse.moveWithin",
                  { rect, pad: 90, ...this.#moveOptions() }, { timeoutMs: 20_000 }
                )
              : await this.#moveAnywhereOnScreenRaw();

            if (r.aborted) {
              // The stroke was cut mid-flight. Not an error and not the end —
              // wait for quiet on the next pass and continue.
              say("Stroke cut short — you moved mid-move");
              continue;
            }
            moves++;
            say(
              `Moved to ${Math.round(r.x)},${Math.round(r.y)}` +
              (app ? ` inside ${app.name}` : " on screen"),
              [`${Math.round(r.actualMs)}ms, ${r.samples} points along the path`]
            );

            await sleep(randInt(700, 1600));

            if (this.cfg.actions.scroll && chance(0.6)) {
              const dy = -randInt(2, 5);
              await this.#device.call("scroll", { dy, ms: randInt(240, 460), device: this.cfg.advanced.scrollDevice });
              say(`Scrolled down ${Math.abs(dy)}`);
              await sleep(randInt(500, 1100));
            }
          }
        }
      }

      say(`Done — ${moves} moves. Every one had a different path, speed and landing point.`);
    } finally {
      // Nothing to restore any more, but the try still guards the narration: a
      // failure mid-demo should surface as a step, not an unhandled rejection.
      say("Demo ended");
    }
  }

  /** Screen-wide move that returns the raw reply, for callers that log it. */
  async #moveAnywhereOnScreenRaw() {
    const caps = await this.#device.require("caps");
    const s = caps.screens[0];
    const x = s.x + randInt(80, Math.max(81, Math.floor(s.w) - 80));
    const y = s.y + randInt(80, Math.max(81, Math.floor(s.h) - 80));
    return this.#device.call(
      "mouse.moveTo", { x, y, ...this.#moveOptions() }, { timeoutMs: 20_000 }
    );
  }

  #onHumanInput(msg) {
    const until = Date.now() + this.cfg.resumeAfterSeconds * 1000;
    if (until <= this.#pausedUntil) return; // already paused at least this long

    this.#pausedUntil = until;
    logger.info(`human input (${msg.kind}) — pausing ${this.cfg.resumeAfterSeconds}s`);
    // Cut whatever stroke is in flight rather than finishing it over the top of
    // the user's own cursor.
    this.#device?.call("abort").catch(() => {});
    this.onState(this.state);
  }

  get #paused() {
    return Date.now() < this.#pausedUntil;
  }

  /**
   * Record why nothing is happening, and announce it once when it changes.
   *
   * The gate itself was always correct; the problem was that it was silent. A run
   * held back by work hours produced no log line, no state change and no visible
   * difference from a crashed executor.
   */
  /**
   * Load, swap or drop the behaviour script to match settings.
   *
   * Re-read on change rather than cached at startup, so choosing a different
   * script — or editing the one in use — takes effect without restarting. The
   * whole point of the script layer is that behaviour is data, not a build.
   */
  #syncScript() {
    const wanted = this.scriptPath
      ? this.scriptPath
      : this.cfg.script
        ? path.join(SCRIPTS_DIR, `${this.cfg.script}.js`)
        : null;

    if (wanted === this.#loadedScriptPath) return;
    this.#loadedScriptPath = wanted;

    if (!wanted) {
      this.script = null;
      logger.info("using the built-in behaviour");
      return;
    }

    try {
      this.script = Script.fromFile(wanted);
      logger.info(`script: ${this.script.meta.name} v${this.script.meta.version}`);
    } catch (e) {
      // Fall back to the built-in behaviour rather than stopping: a typo in a
      // script name should not take the whole run down for the day.
      this.script = null;
      logger.error(`could not load script "${this.cfg.script}" — using the built-in behaviour (${e.message})`);
    }
  }

  #setGate(reason) {
    if (this.#gate === reason) return;
    this.#gate = reason;

    if (reason === "stopped") {
      logger.info("stopped");
    } else if (reason === null) {
      logger.info("session started — running until you stop it");
    }
    this.onState(this.state);
  }

  /**
   * Sleep in slices so a pause or a stop lands promptly.
   *
   * @param {number} at
   * @param {Function} [keepGoing]  checked between slices; returning false ends
   *   the wait early. Returns false if the wait was cut short.
   */
  async #sleepUntil(at, keepGoing = null) {
    while (!this.#stopping && Date.now() < at) {
      await sleep(Math.min(400, at - Date.now()));
      if (keepGoing && !keepGoing()) return false;
    }
    return !this.#stopping;
  }

  /**
   * Re-read settings and report whether the session is still running.
   *
   * Used while waiting for a burst. The loop only reloaded settings once per
   * pass, and a pass lasts as long as the whole segment's bursts take — so
   * pressing Stop did nothing until every queued burst had fired, sometimes
   * minutes later.
   */
  #stillRunning() {
    try {
      this.cfg = this.#loadSettings();
    } catch {
      // Keep the previous values; the loop logs the parse failure on its next pass.
    }
    return sessionState(this.cfg).state === "running";
  }

  // ── main loop ─────────────────────────────────────────────────────────────

  async #loop() {
    let plannedSegment = null;
    let lastBurstAt = null;

    while (!this.#stopping) {
      // Re-read settings every pass: start/stop, busy level and the action
      // switches all take effect without a restart.
      try {
        this.cfg = this.#loadSettings();
      } catch (e) {
        logger.error(`settings.json rejected, keeping the previous values: ${e.message}`);
      }

      this.#syncScript();

      const now = Date.now();
      const session = sessionState(this.cfg, now);

      if (session.state !== "running") {
        this.#setGate(session.state);

        // A finished or stopped session does not carry its seam forward — the
        // next Start begins a fresh one, opener included.
        lastBurstAt = null;
        plannedSegment = null;
        this.#sessionOpened = false;

        // Poll tightly while stopped. This was two seconds, which is dead time
        // between clicking Start and anything at all happening — stacked on top
        // of the opening delay and the stroke itself, the pointer finished
        // moving closer to six seconds after the click, which reads as a button
        // that did nothing. Re-reading a 1KB file four times a second costs
        // nothing next to that.
        await sleep(250);
        continue;
      }
      this.#setGate(null);

      const segmentStart = segmentStartFor(now);
      if (!plannedSegment || plannedSegment.segmentStart !== segmentStart) {
        plannedSegment = planSegment({
          cfg: this.cfg,
          personality: this.personality,
          segmentStart,
          lastBurstAt,
          sessionStart: this.cfg.startedAt,
          // Only plan the part of this segment still ahead of us. Pressing Start
          // partway through one would otherwise produce a plan made entirely of
          // instants that have already passed.
          notBefore: now,
          // First segment of this session: open with an immediate move so Start
          // visibly does something rather than appearing to have missed.
          openNow: !this.#sessionOpened,
        });
        this.#sessionOpened = true;

        const t = new Date(segmentStart).toTimeString().slice(0, 5);
        logger.info(
          `segment ${t} — ${plannedSegment.activityPercent}% ` +
          `(minutes ${plannedSegment.minutes.join(",")})` +
          (plannedSegment.gapForced ? " [raised to stay under the idle limit]" : "")
        );
        this.onState(this.state);
      }

      // Anything already past is missed — the minute it belonged to is gone.
      const due = plannedSegment.bursts.filter((b) => b.at > Date.now());
      if (!due.length) {
        await this.#sleepUntil(plannedSegment.segmentEnd, () => this.#stillRunning() && !this.#paused);
        if (this.#paused) {
          await this.#waitOutPause();
          if (!this.#stopping && this.#stillRunning() && await this.#resumeNow()) {
            lastBurstAt = Date.now();
          }
        }
        continue;
      }

      let i = 0;
      while (i < due.length && !this.#stopping) {
        const burst = due[i];

        // The user is at the keyboard. Wait until they have genuinely been quiet
        // for the timeout, then pick up straight away rather than at the next
        // scheduled minute — which could be over a minute off, and read as the
        // app having died.
        if (this.#paused) {
          await this.#waitOutPause();
          if (this.#stopping || !this.#stillRunning()) break;
          if (await this.#resumeNow()) lastBurstAt = Date.now();
          continue; // re-evaluate this burst: its moment may have passed
        }

        // Wait for the burst, but wake early if the user starts using the machine
        // or stops the session.
        await this.#sleepUntil(burst.at, () => this.#stillRunning() && !this.#paused);
        if (!this.#stillRunning()) break;
        if (this.#paused) continue; // the top of the loop handles the wait + resume

        // A burst whose minute has already elapsed (because we were paused, or
        // just resumed) is not worth doing — the minute is gone and the resume
        // burst already covered the present one.
        const minuteEnd = plannedSegment.segmentStart + (burst.minute + 1) * MINUTE_MS;
        if (Date.now() >= minuteEnd) { i++; continue; }

        // Step away from the desk now and then. Costs the minutes it covers,
        // which is the point — a day with no gaps in it does not look like a day.
        if (this.#shouldBreak()) {
          const secs = randInt(this.cfg.advanced.breakMinSec, this.cfg.advanced.breakMaxSec);
          logger.info(`taking a break for ${secs}s`);
          // A break can run to 90s; Stop must not have to wait it out.
          if (!(await this.#sleepUntil(Date.now() + secs * 1000, () => this.#stillRunning()))) break;
          i++;
          continue;
        }

        try {
          await this.#perform(burst);
          this.#burstsSinceBreak++;
          lastBurstAt = Date.now();
        } catch (e) {
          if (!(e instanceof Yielded)) logger.warn(`burst failed: ${e.message}`);
        }
        i++;
      }
    }
  }

  /**
   * Block until the user has been quiet for the full timeout.
   *
   * Re-reads the deadline on every tick. The old wait captured pausedUntil once,
   * so while the user kept typing — each keystroke pushing the deadline out — the
   * sleep still ended at the original value, logged "picked back up" in the
   * middle of their sentence, and threw the burst away.
   */
  async #waitOutPause() {
    while (this.#paused && !this.#stopping) await sleep(200);
  }

  /**
   * Do something immediately after a pause ends.
   *
   * Without this the loop went back to waiting for the next planned minute,
   * which at busy is one to two minutes away — so the user stopped, waited the
   * ten seconds they had configured, saw nothing, and reasonably concluded it
   * was broken. Resuming is treated like opening: an app switch when allowed,
   * otherwise a move, then the schedule carries on.
   */
  async #resumeNow() {
    logger.info(`picked back up after ${this.cfg.resumeAfterSeconds}s of quiet`);
    this.onState(this.state);

    const kind = this.cfg.actions.switchApps && this.cfg.apps.length ? "switchApp" : "move";
    try {
      await this.#perform({ kind, minute: -1, filler: false, resume: true });
      this.#burstsSinceBreak++;
      return true;
    } catch (e) {
      if (!(e instanceof Yielded)) logger.warn(`resume failed: ${e.message}`);
      return false;
    }
  }

  // ── actions ───────────────────────────────────────────────────────────────

  #moveOptions() {
    const a = this.cfg.advanced;
    return {
      curve: a.curveAmount,
      tremor: a.tremorAmplitude,
      overshoot: a.overshootChance,
      subMoves: a.subMoveCount,
      sampleRateHz: a.sampleRateHz,
      fittsA: a.fittsA * this.personality.paceMult,
      fittsB: a.fittsB * this.personality.paceMult,
    };
  }

  /**
   * Pick the next app to switch to.
   *
   * Not round-robin. Cycling the list in order produced a perfectly repeating
   * Slack → Chrome → Figma → Slack sequence all day, which is the kind of
   * regularity that survives being averaged and shows up plainly in an app-usage
   * report. This weights the choice instead: anything on cooldown is out, the app
   * we just came from is heavily penalised so it is unlikely but not impossible
   * twice running, and everything else is equally likely.
   */
  #nextApp() {
    const apps = this.cfg.apps;
    if (!apps.length) return null;
    const now = Date.now();

    let available = apps.filter((a) => (this.#appCooldown.get(a.bundleId) ?? 0) <= now);

    // Cooldowns exist to stop the rotation ping-ponging, not to stop it running.
    // With a short app list they did exactly that: two apps on a 12-minute
    // cooldown left nothing available almost always, every switch quietly
    // degraded into a plain move, and the app never visibly changed windows.
    // When everything is cooling, fall back to whichever app has been waiting
    // longest rather than giving up.
    if (!available.length) {
      const byStalest = [...apps].sort(
        (a, b) => (this.#appCooldown.get(a.bundleId) ?? 0) - (this.#appCooldown.get(b.bundleId) ?? 0)
      );
      // Never bounce straight back to the app just left, even when everything
      // is cooling — that is the ping-pong, and with three apps this fallback
      // is the usual path, so the exclusion has to live here.
      const notJustLeft = (a) => now - (this.#leftAt.get(a.bundleId) ?? 0) > 20_000;
      available = byStalest.filter((a) => a.name !== this.#currentApp && notJustLeft(a));
      if (!available.length) available = byStalest.filter((a) => a.name !== this.#currentApp);
      if (!available.length) available = byStalest;
    }

    const weights = available.map((a) => (a.name === this.#currentApp ? 0.12 : 1));
    const total = weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    for (let i = 0; i < available.length; i++) {
      if ((r -= weights[i]) <= 0) return available[i];
    }
    return available[available.length - 1];
  }

  /**
   * Whether to take a longer break now.
   *
   * A person leaves their desk. Unbroken coverage of every segment for eight
   * hours is itself a pattern, and the settings already named this behaviour —
   * breakEvery / breakMinSec / breakMaxSec were validated and documented but
   * never actually read, so the app quietly did not do the thing its own config
   * claimed. The counter is jittered so breaks do not land on a fixed cadence
   * either.
   */
  #shouldBreak() {
    const { breakEvery } = this.cfg.advanced;
    if (!breakEvery) return false;
    if (this.#burstsSinceBreak < breakEvery * (0.7 + Math.random() * 0.6)) return false;
    this.#burstsSinceBreak = 0;
    return true;
  }

  /**
   * Run a script instead of the built-in behaviour for this burst.
   *
   * A script owns the whole burst: it decides where to go and how long to stay,
   * within the same action switches and the same yield rules. `yielded` errors
   * are the user taking over, which is not a failure.
   */
  async runScript(script) {
    const ctx = buildContext({
      cfg: this.cfg,
      personality: this.personality,
      device: this.#device,
      moveOptions: () => this.#moveOptions(),
      isPaused: () => this.#paused,
    });

    try {
      await script.run(ctx);
    } catch (e) {
      if (e.yielded) {
        logger.info(`${script.id} yielded to the user`);
        return;
      }
      logger.warn(`${script.id} failed: ${e.message}`);
    }
  }

  /**
   * How many actions one burst performs.
   *
   * Scored presence needs a single event to claim a minute, so a burst used to be
   * exactly one action — at "busy" that came to eight strokes of about 1.5s each
   * per ten minutes, twelve seconds of movement in six hundred. It satisfied the
   * measurement and looked completely dead, because nobody working moves once a
   * minute and then freezes.
   *
   * The count follows the level: roughly half the target minute count, jittered.
   * Light stays sparse, busy fills the minute the way being busy actually does.
   */
  /**
   * How full a burst is: how many actions, and how tightly packed.
   *
   * Derived from the level rather than fixed. The first version did roughly half
   * the target minute count with 0.9-4s gaps, which at "busy" was four actions
   * over ten seconds followed by fifty seconds of nothing, once a minute — the
   * dead air was the whole complaint. Heads-down means the cursor is doing
   * something most of the time, not twitching on a schedule.
   *
   * At busy this fills most of the minute; at light it stays genuinely sparse,
   * because light should look like someone barely at the desk.
   */
  #burstProfile() {
    // Heads-down, the only mode: around a dozen actions with short gaps, so a
    // burst fills most of its minute rather than twitching once and stopping.
    return { actions: 12 + randInt(-1, 2), gapMin: 500, gapMax: 1800 };
  }

  /** A follow-up action inside a burst — never another app switch. */
  #followUpKind() {
    const r = Math.random();
    // A switch mid-burst, occasionally — someone flicking to another window to
    // check something and coming back. Only when there is more than one app to
    // flick between.
    // 5%, down from 12%. At 12% a dozen-action burst averaged well over one
    // extra switch, and combined with the cooldown fallback that produced runs
    // like Zed → Discord → Zed inside eight seconds — thirteen of forty switches
    // in one session landed within ten seconds of the previous one.
    if (this.cfg.actions.switchApps && this.cfg.apps.length > 1 && r < 0.05) return "switchApp";
    if (this.cfg.actions.scroll && r < 0.37) return "scroll";
    return "move";
  }

  /**
   * A landing point well away from where the cursor already is.
   *
   * Points used to be drawn biased toward the middle of the window, which kept
   * consecutive targets close together and made every move a short hop. Sampling
   * candidates and taking the farthest gives long, obvious traverses — which is
   * both what reads as activity and what a person crossing a window actually
   * does.
   */
  #farPointIn(rect, from, pad) {
    const p = Math.min(pad, Math.min(rect.w, rect.h) / 2 - 4);
    let best = null, bestDist = -1;

    for (let i = 0; i < 6; i++) {
      const c = {
        x: rect.x + p + Math.random() * (rect.w - 2 * p),
        y: rect.y + p + Math.random() * (rect.h - 2 * p),
      };
      const d = from
        ? Math.hypot(c.x - from.x, c.y - from.y)
        : Math.random();
      if (d > bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  async #perform(burst) {
    // A configured script takes over the burst entirely.
    if (this.script) return this.runScript(this.script);

    const { actions, gapMin, gapMax } = this.#burstProfile();
    for (let i = 0; i < actions; i++) {
      if (this.#stopping || this.#paused) return;

      // The planned kind leads; the rest are moves, nudges and scrolls around it,
      // so a burst reads as a stretch of working rather than one isolated twitch.
      await this.#performOne(i === 0 ? burst.kind : this.#followUpKind());

      // Pause-aware gap. A burst now runs a dozen actions, so a plain sleep here
      // meant the loop could not notice you had started typing until the gap
      // expired — the difference between getting out of the way and appearing to
      // ignore you.
      if (i < actions - 1) {
        const until = Date.now() + randInt(gapMin, gapMax);
        while (Date.now() < until && !this.#stopping && !this.#paused) {
          await sleep(Math.min(150, until - Date.now()));
        }
      }
    }
  }

  async #performOne(kind) {
    switch (kind) {
      case "switchApp": {
        const app = this.#nextApp();
        if (!app) return this.#moveSomewhere();

        const res = await this.#device.call("apps.activate", { bundleId: app.bundleId });
        if (res.ok === false) {
          // A configured app that is closed should not be retried every burst.
          this.#appCooldown.set(app.bundleId, Date.now() + 5 * 60_000);
          logger.warn(`${app.name}: ${res.error} — skipping it for 5 minutes`);
          return this.#moveSomewhere();
        }

        const prev = this.cfg.apps.find((a) => a.name === this.#currentApp);
        if (prev) this.#leftAt.set(prev.bundleId, Date.now());
        this.#currentApp = app.name;
        this.#appCooldown.set(
          app.bundleId, Date.now() + this.cfg.advanced.appCooldownMinutes * 60_000
        );
        logger.info(`→ ${app.name}`);
        this.onState(this.state);

        await this.#moveIntoApp(app);
        return;
      }

      case "scroll":
        return this.#scrollBurst();

      default:
        await this.#moveSomewhere();
    }
  }

  /**
   * One scrolling burst.
   *
   * Three shapes rather than one direction with a bias, because reading does not
   * look like a single flick. Sometimes one nudge, sometimes a few in a row with
   * pauses to read between them, and sometimes a scroll back up — the thing
   * people do constantly when they overshoot a line or want a second look.
   */
  async #scrollBurst() {
    const shape = Math.random();
    const pause = () => sleep(randInt(400, 1600));

    // Put the pointer somewhere plausible first, most of the time.
    //
    // A scroll burst used to emit wheel events with the cursor frozen exactly
    // where the last burst left it, which is not how anyone scrolls — the hand
    // is on the trackpad, so the pointer drifts. It also means a scroll-only
    // minute contributed no pointer movement at all.
    if (this.cfg.actions.moveMouse && chance(0.75)) {
      try {
        await this.#moveSomewhere();
      } catch (e) {
        if (e instanceof Yielded) throw e;
        // A failed reposition is no reason to skip the scroll itself.
      }
      await sleep(randInt(200, 700));
      if (this.#paused) return;
    }

    if (shape < 0.5) {
      const dy = -randInt(2, 6);
      await this.#device.call("scroll", { dy, ms: randInt(220, 520), device: this.cfg.advanced.scrollDevice });
      logger.info(`scrolled down ${Math.abs(dy)}`);
      return;
    }

    if (shape < 0.82) {
      // Reading down the page in steps.
      const steps = randInt(2, 4);
      for (let i = 0; i < steps; i++) {
        if (this.#paused) return;
        const dy = -randInt(2, 5);
        await this.#device.call("scroll", { dy, ms: randInt(200, 420), device: this.cfg.advanced.scrollDevice });
        if (i < steps - 1) await pause();
      }
      logger.info(`read down the page in ${steps} steps`);
      return;
    }

    // Down, then back up — a second look at something just passed.
    const down = -randInt(3, 7);
    await this.#device.call("scroll", { dy: down, ms: randInt(240, 480), device: this.cfg.advanced.scrollDevice });
    await pause();
    if (this.#paused) return;
    const up = randInt(1, Math.max(1, Math.abs(down) - 1));
    await this.#device.call("scroll", { dy: up, ms: randInt(200, 400), device: this.cfg.advanced.scrollDevice });
    logger.info(`scrolled down ${Math.abs(down)}, back up ${up}`);
  }

  async #moveIntoApp(app) {
    const w = await this.#device.call("apps.frontWindow", { bundleId: app.bundleId });
    if (w.ok === false || !w.rect) {
      logger.warn(`${app.name}: ${w.error ?? "no window"} — moving on screen instead`);
      return this.#moveAnywhereOnScreen();
    }
    const res = await this.#moveFarWithin(w.rect, 60);
    this.#afterMove(res, app.name);
  }

  /** Cross the window to a point well away from the cursor's current spot. */
  async #moveFarWithin(rect, pad) {
    const pos = await this.#device.call("mouse.pos");
    const target = this.#farPointIn(rect, pos.ok === false ? null : pos, pad);

    return this.#device.call(
      "mouse.moveTo",
      { x: Math.round(target.x), y: Math.round(target.y), ...this.#moveOptions() },
      { timeoutMs: 20_000 }
    );
  }

  /** Move inside whatever app the rotation is currently on, or on screen if that
   *  app has no window we can read. */
  async #moveSomewhere() {
    // Prefer the app already in front — a move that is not a switch should stay
    // where the person is, not teleport the pointer into a background window.
    const app =
      this.cfg.apps.find((a) => a.name === this.#currentApp) ?? this.cfg.apps[0] ?? null;

    if (app) {
      const w = await this.#device.call("apps.frontWindow", { bundleId: app.bundleId });
      if (w.ok !== false && w.rect) {
        const res = await this.#moveFarWithin(w.rect, 70);
        return this.#afterMove(res, app.name);
      }
      // Falling back is fine, silently falling back is not — a permanently
      // windowless app in the list would otherwise look like it was working.
      logger.warn(`${app.name}: ${w.error ?? "no window"} — moving on screen instead`);
    }

    return this.#moveAnywhereOnScreen();
  }

  async #moveAnywhereOnScreen() {
    const caps = await this.#device.call("caps");
    const s = caps.screens?.[0];
    if (!s) throw new Error("no screens reported");

    const x = s.x + randInt(60, Math.max(61, Math.floor(s.w) - 60));
    const y = s.y + randInt(60, Math.max(61, Math.floor(s.h) - 60));
    const res = await this.#device.call(
      "mouse.moveTo", { x, y, ...this.#moveOptions() }, { timeoutMs: 20_000 }
    );
    this.#afterMove(res, "screen");
  }

  #afterMove(res, where) {
    if (res.aborted) throw new Yielded();
    const x = Math.round(res.x ?? 0), y = Math.round(res.y ?? 0);
    logger.info(
      `moved ${where === "screen" ? "" : `into ${where} `}(${x},${y}) ` +
      `${Math.round(res.actualMs ?? 0)}ms ${res.samples ?? 0} samples`
    );
  }
}

// ── headless entry point ────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());

if (isMain) {
  logger.echoToConsole();

  // Env overrides so a headless run can be driven without editing settings.json.
  //   SETTINGS=path  RUN=0|1
  const overrides = {};
  if (process.env.RUN != null) overrides.running = process.env.RUN !== "0";

  const runner = new Runner({
    settingsPath: process.env.SETTINGS || SETTINGS_PATH,
    scriptPath: process.env.SCRIPT || null,
    overrides,
  });

  if (runner.script) {
    logger.info(`script: ${runner.script.meta.name} v${runner.script.meta.version}`);
  }

  const shutdown = async () => {
    logger.info("shutting down…");
    await runner.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Diagnostics live here rather than in the app.
  //
  //   CHECK=1 node src/main/executor/runner.js   every layer, no cursor movement
  //   DEMO=1  node src/main/executor/runner.js   the real behaviour, right now
  //
  // They were buttons in the settings panel and are not any more: a shipped app
  // whose job is to be unremarkable should not carry a "test everything" section
  // on its front page. Kept reachable because they are genuinely the fastest way
  // to tell which layer is misbehaving.
  const diagnostic = process.env.CHECK ? "check" : process.env.DEMO ? "demo" : null;

  if (diagnostic) {
    const show = (s) => {
      logger.info(`${s.ok ? "✓" : "✕"} ${s.name}${s.detail ? ` — ${s.detail}` : ""}`);
      for (const line of s.data ?? []) logger.info(`    ${line}`);
    };

    runner.startDeviceOnly()
      .then(() =>
        diagnostic === "check"
          ? runner.selfTest({ onStep: show })
          : runner.demo({ onStep: show })
      )
      .then(() => runner.stop())
      .then(() => process.exit(0))
      .catch(async (e) => {
        logger.error(`fatal: ${e.message}`);
        await runner.stop();
        process.exit(1);
      });
  } else {
    runner.start().catch((e) => {
      logger.error(`fatal: ${e.message}`);
      process.exit(1);
    });
  }
}
