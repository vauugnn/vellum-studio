import React from "react";

// Small shared pieces. Everything here is deliberately plain — the panel's job is
// to make the settings legible to someone who has never read the README, so the
// controls carry their explanation next to them rather than in a tooltip.

export function Switch({ checked, onChange, label, hint, tone = "normal" }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-2">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 h-[18px] w-[30px] shrink-0 rounded-full border transition-colors ${
          checked
            ? tone === "risky"
              ? "border-held/60 bg-held/70"
              : "border-live/60 bg-live/70"
            : "border-ink-500 bg-ink-600"
        }`}
      >
        <span
          className={`block h-3.5 w-3.5 rounded-full bg-vellum-100 transition-transform ${
            checked ? "translate-x-[13px]" : "translate-x-[2px]"
          }`}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-sm text-vellum-200">{label}</span>
        {hint && <span className="hint mt-0.5 block">{hint}</span>}
      </span>
    </label>
  );
}

export function Section({ title, children, action }) {
  return (
    <section className="border-t rule px-5 py-4 first:border-t-0">
      <header className="mb-2 flex items-center justify-between">
        <h2 className="field-label">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/**
 * Status dot + word.
 *
 * Every reason for standing still gets its own word. "Stopped", "paused" and
 * "waiting for work hours" are three different situations, and collapsing them
 * into one made a correctly idle app look broken — you press Start outside your
 * hours, the dot says stopped, and nothing explains itself.
 */
export function StatusDot({ state, settings }) {
  // Recompute from the deadline on a tick rather than trusting `state.paused`.
  //
  // That flag is evaluated when the executor pushes state, and nothing pushes
  // again when the pause simply runs out — so the panel sat on "paused — you're
  // using the computer" indefinitely while the app was, in fact, working.
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);

  const paused = state.pausedUntil != null && Date.now() < state.pausedUntil;
  const secondsLeft = paused ? Math.ceil((state.pausedUntil - Date.now()) / 1000) : 0;

  // Stopped-or-not comes from the settings file, which is the actual switch, not
  // from executor-pushed state. The executor only pushes when something changes,
  // so before its first message the panel fell back to a default that read
  // "stopped" while the cursor was visibly moving.
  const started = settings?.running ?? state.running;

  // How much of a timed session is left. Recomputed on the same tick, so it
  // counts down rather than freezing at whatever the last push happened to say.
  const remaining = settings?.runForMinutes != null && settings?.startedAt != null
    ? settings.runForMinutes - (Date.now() - settings.startedAt) / 60_000
    : null;

  const [tone, word, hint] = !started
    ? ["bg-vellum-400", "stopped", null]
    : paused
      ? ["bg-held", "paused", `you're using the computer — ${secondsLeft}s`]
      : state.gate === "finished" || (remaining != null && remaining <= 0)
        ? ["bg-vellum-400", "finished", "ran its full length"]
        : ["bg-live", "running",
           remaining != null ? `${Math.ceil(remaining)} min left` : null];

  return (
    <span className="flex items-center gap-2">
      <span className={`h-2 w-2 rounded-full ${tone}`} />
      <span className="text-sm text-vellum-200">{word}</span>
      {hint && <span className="text-[11px] text-vellum-400">— {hint}</span>}
    </span>
  );
}

/**
 * Activity over the last hour, one bar per 10-minute segment.
 *
 * Labelled as an estimate on purpose: this is the app's own count of the minutes
 * it touched, not a reading from anywhere else. Presenting it as the real number
 * would be the one genuinely misleading thing this window could do.
 */
export function ActivityMeter({ segments }) {
  const recent = segments.slice(-6);
  const avg = recent.length
    ? Math.round(recent.reduce((s, x) => s + x.activityPercent, 0) / recent.length)
    : 0;

  return (
    <div>
      <div className="flex h-12 items-end gap-1.5">
        {recent.length === 0 && (
          <span className="hint self-center">nothing planned yet</span>
        )}
        {recent.map((seg) => (
          <div key={seg.at} className="flex flex-1 flex-col items-center gap-1">
            <div
              className="w-full rounded-sm bg-nib/70"
              style={{ height: `${Math.max(4, seg.activityPercent * 0.42)}px` }}
              title={`${new Date(seg.at).toTimeString().slice(0, 5)} — ${seg.activityPercent}%`}
            />
            <span className="text-[9px] text-vellum-400">
              {new Date(seg.at).toTimeString().slice(0, 5)}
            </span>
          </div>
        ))}
      </div>
      {recent.length > 0 && (
        <p className="hint mt-2">
          about {avg}% on average — this is what Vellum planned, not a reading from
          anywhere else.
        </p>
      )}
    </div>
  );
}
