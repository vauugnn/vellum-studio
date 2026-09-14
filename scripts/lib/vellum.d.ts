// Type declarations for the script runtime.
//
// Same role as click-stream/phone/src/droidwright.d.ts: nothing here is imported
// at run time, it exists so a script typechecks and autocompletes in an editor.
// Everything a script can reach is on `ctx` — there is no module system inside
// the sandbox and no access to the filesystem, network or process.

declare namespace Vellum {
  interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
  }

  interface App {
    bundleId: string;
    name: string;
    pid: number;
    active: boolean;
    hidden: boolean;
  }

  interface MoveResult {
    ok: boolean;
    x: number;
    y: number;
    samples: number;
    actualMs: number;
    /** True when the user took over mid-stroke and it was cut short. */
    aborted: boolean;
  }

  interface MoveOptions {
    /** Landing inset from the rect's edges, in pixels. */
    pad?: number;
    /** Fixed duration; omit to derive one from Fitts's law. */
    ms?: number;
    /** Multiplier on the path's bow away from a straight line. */
    curve?: number;
    /** Multiplier on tremor amplitude. */
    tremor?: number;
    /** Probability of overshooting a distant target and correcting back. */
    overshoot?: number;
    /** Corrective hops after the ballistic phase, 0-3. */
    subMoves?: number;
    sampleRateHz?: number;
  }

  /** Deterministic per-machine traits. Stable across restarts by design. */
  interface Personality {
    key: string;
    paceMult: number;
    dwellMult: number;
    busyMult: number;
    lunchAt: number;
  }

  interface Config {
    running: boolean;
    actions: {
      moveMouse: boolean;
      switchApps: boolean;
      scroll: boolean;
      pressKeys: boolean;
      click: boolean;
    };
    apps: { bundleId: string; name: string }[];
    advanced: Record<string, unknown>;
  }

  interface Ctx {
    config: Config;
    personality: Personality;

    log(msg: string): void;
    /** Capped at 10 minutes per call. */
    sleep(ms: number): Promise<void>;
    rand(min: number, max: number): number;
    chance(probability: number): boolean;
    pick<T>(list: T[]): T;
    /** A pause sampled from the configured dwell buckets. */
    dwell(): number;

    /**
     * Throws if the user has taken over. Call it between steps in any loop —
     * it is what lets a long script unwind promptly instead of fighting the
     * user's own cursor for the rest of its run.
     */
    yieldIfHuman(): void;

    mouse: {
      pos(): Promise<{ x: number; y: number }>;
      moveTo(x: number, y: number, opts?: MoveOptions): Promise<MoveResult>;
      moveWithin(rect: Rect, opts?: MoveOptions): Promise<MoveResult>;
      /** Negative scrolls down the page. */
      scroll(dy: number, ms?: number): Promise<unknown>;
    };

    app: {
      list(): Promise<App[]>;
      activate(bundleId: string): Promise<unknown>;
      /** Null when the app is not running or exposes no readable window. */
      frontWindow(bundleId: string): Promise<Rect | null>;
    };

    /** No-op unless actions.click is on. Only ever lands on empty desktop. */
    click(opts?: { button?: "left" | "right" }): Promise<unknown>;
    /** No-op unless actions.pressKeys is on and the key is on the allowlist. */
    key(name: "shift" | "control" | "option" | "command"): Promise<unknown>;
  }
}

declare const ctx: Vellum.Ctx;
declare function vellumRun(ctx: Vellum.Ctx): Promise<void>;
