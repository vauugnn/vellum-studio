import React, { useEffect, useRef, useState } from "react";

// Small shared pieces. Everything here is deliberately plain — the panel's job is
// to make the settings legible to someone who has never read the README, so the
// controls carry their explanation next to them rather than in a tooltip.

/**
 * The mark: three ink circles, every overlap a flat fill.
 *
 * Radius 16 on a 64 grid, centred at 24,25 — 40,25 — 32,38.9. The overlaps are
 * painted rather than blended so the mark composites the same on any ground.
 * No container, no gradient, and never drawn below 16px.
 */
export function Mark({ size = 16, className = "" }) {
  // Clip paths are document-global, so two marks on one page need distinct ids.
  const id = React.useId().replace(/:/g, "");
  const a = `${id}a`;
  const b = `${id}b`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <clipPath id={a}><circle cx="24" cy="25" r="16" /></clipPath>
        <clipPath id={b}><circle cx="40" cy="25" r="16" /></clipPath>
      </defs>
      <circle cx="24" cy="25" r="16" fill="#D8452C" />
      <circle cx="40" cy="25" r="16" fill="#E8B31F" />
      <circle cx="32" cy="38.9" r="16" fill="#4459E0" />
      <g clipPath={`url(#${a})`}><circle cx="40" cy="25" r="16" fill="#E5711F" /></g>
      <g clipPath={`url(#${a})`}><circle cx="32" cy="38.9" r="16" fill="#8B3FD4" /></g>
      <g clipPath={`url(#${b})`}><circle cx="32" cy="38.9" r="16" fill="#3E9E5C" /></g>
      <g clipPath={`url(#${a})`}>
        <g clipPath={`url(#${b})`}><circle cx="32" cy="38.9" r="16" fill="#33305E" /></g>
      </g>
    </svg>
  );
}

/**
 * A row: label and explanation on the left, the control on the right.
 */
export function Row({ label, hint, children }) {
  return (
    <div className="flex items-start justify-between gap-6 py-2">
      <span className="min-w-0">
        <span className="block text-body text-chalk">{label}</span>
        {hint && <span className="hint mt-0.5 block">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

/**
 * On/off. Monochrome on purpose: the accent is reserved for the one thing that
 * is live or focused in a region, and a column of enabled actions is not that.
 * On reads as chalk, off as an empty frame.
 */
export function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-6 py-2">
      <span className="min-w-0">
        <span className="block text-body text-chalk">{label}</span>
        {hint && <span className="hint mt-0.5 block">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 flex h-4 w-7 shrink-0 items-center border px-[2px] ${
          checked ? "border-chalk bg-chalk" : "border-edge bg-transparent hover:border-dust"
        }`}
      >
        <span
          className={`block h-[10px] w-[10px] rounded-[1px] transition-transform ${
            checked ? "translate-x-[12px] bg-pitch" : "translate-x-0 bg-dust"
          }`}
        />
      </button>
    </label>
  );
}

export function Section({ title, children, action }) {
  return (
    <section className="group border-t border-seam px-5 py-4 first:border-t-0">
      <header className="mb-1 flex items-center justify-between">
        <h2 className="rail">{title}</h2>
        {action && <span className="recede">{action}</span>}
      </header>
      {children}
    </section>
  );
}

/** A small text action in a section header. */
export function Action(props) {
  return <button className="rail no-drag hover:text-chalk" {...props} />;
}

/**
 * The one button style. Primary is the single ultramarine element in its
 * region; everything else is a hairline frame.
 */
export function Button({ primary = false, className = "", ...props }) {
  return (
    <button
      className={`no-drag h-7 px-[9px] font-mono text-rail ${
        primary
          ? "bg-ultra text-white hover:bg-ultra-deep"
          : "border border-edge text-dust hover:border-dust hover:text-chalk"
      } ${className}`}
      {...props}
    />
  );
}

const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238A9099' stroke-width='1'/%3E%3C/svg%3E\")";

export function Select({ className = "", ...props }) {
  return (
    <select
      className={`well h-8 w-full appearance-none bg-no-repeat pl-2 pr-7 text-body text-chalk hover:border-dust focus:border-ultra focus:outline-none ${className}`}
      style={{ backgroundImage: CHEVRON, backgroundPosition: "right 8px center" }}
      {...props}
    />
  );
}

/**
 * A number that is a drag target first and a text field second.
 *
 * Drag sideways to change it: one step per 6px, Shift for fine (one per 24px),
 * Option for coarse (five per 6px). A click that does not drag opens it for
 * typing. No steppers.
 */
export function Scrub({ value, onChange, min, max, step = 1, unit = "" }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const drag = useRef(null);
  const input = useRef(null);

  const clamp = (v) => Math.max(min, Math.min(max, v));

  const onPointerDown = (e) => {
    if (editing || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, start: value, last: value, moved: false };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) >= 3) d.moved = true;
    if (!d.moved) return;
    const perPx = e.shiftKey ? 24 : 6;
    const mult = e.altKey ? 5 : 1;
    const next = clamp(d.start + Math.trunc(dx / perPx) * mult * step);
    if (next !== d.last) {
      d.last = next;
      onChange(next);
    }
  };
  const onPointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (d && !d.moved) {
      setDraft(String(value));
      setEditing(true);
    }
  };
  const onKeyDown = (e) => {
    const by = (e.shiftKey ? 1 : e.altKey ? 5 : 1) * step;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") onChange(clamp(value + by));
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") onChange(clamp(value - by));
    else if (e.key === "Enter") {
      setDraft(String(value));
      setEditing(true);
    } else return;
    e.preventDefault();
  };

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const n = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(n)) onChange(clamp(Math.round(n / step) * step));
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={input}
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
        className="h-7 w-20 rounded border border-ultra bg-pitch px-2 text-right font-mono text-body text-chalk outline-none"
      />
    );
  }

  return (
    <span
      role="spinbutton"
      tabIndex={0}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      title="Drag to change · Shift for fine · Option for coarse · click to type"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      className="well inline-flex h-7 w-20 shrink-0 cursor-ew-resize items-center justify-end gap-1 px-2 font-mono text-body text-chalk hover:border-dust focus-visible:border-ultra focus-visible:outline-none"
    >
      {value}
      {unit && <span className="text-dust">{unit}</span>}
    </span>
  );
}

/**
 * Status dot + word.
 *
 * Every reason for standing still gets its own word. "Stopped" and "paused" are
 * different situations, and collapsing them made a correctly idle app look
 * broken. The dot is the one place the accent appears in the title bar: filled
 * ultramarine while live, filled grey while held, an empty frame when stopped.
 */
export function StatusDot({ state, settings }) {
  // Recompute from the deadline on a tick rather than trusting `state.paused`.
  //
  // That flag is evaluated when the executor pushes state, and nothing pushes
  // again when the pause simply runs out — so the panel sat on "paused" while
  // the app was, in fact, working.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);

  // Stopped-or-not comes from the settings file, which is the actual switch, not
  // from executor-pushed state. The executor only pushes when something changes,
  // so before its first message the panel fell back to a default that read
  // "stopped" while the cursor was visibly moving.
  const started = settings?.running ?? state.running;

  // A hold only means anything while running; the deadline outlives Stop.
  const paused = started && state.pausedUntil != null && Date.now() < state.pausedUntil;
  const secondsLeft = paused ? Math.ceil((state.pausedUntil - Date.now()) / 1000) : 0;

  const [dot, word] = !started
    ? ["border border-edge", "stopped"]
    : paused
      ? ["bg-dust", "paused"]
      : ["bg-ultra", "running"];

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="rail text-chalk">{word}</span>
      {paused && (
        <span className="hint truncate">
          you're using the computer · <span className="font-mono">{secondsLeft}s</span>
        </span>
      )}
    </span>
  );
}
