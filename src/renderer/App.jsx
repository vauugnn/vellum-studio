import React, { useEffect, useRef } from "react";

import { useStore } from "./store.js";
import { Switch, Section, StatusDot, ActivityMeter } from "./components.jsx";

const BUSY_LEVELS = [
  ["light", "Light", "a quiet day"],
  ["normal", "Normal", "steady, with breaks"],
  ["busy", "Busy", "heads-down"],
];

export default function App() {
  const {
    settings, state, logs, apps, scripts, error, ready,
    init, patch, setAction, refreshApps,
  } = useStore();

  useEffect(() => { init(); }, []);

  if (!ready || !settings) {
    return <div className="grid h-full place-items-center text-sm text-vellum-400">loading…</div>;
  }

  return (
    <div className="flex h-full flex-col bg-ink-800">
      <TitleBar state={state} settings={settings} patch={patch} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="mx-5 mt-4 rounded border border-held/40 bg-held/10 px-3 py-2 text-xs text-held">
            {error}
          </div>
        )}

        <Section title="How busy should it look?">
          <div className="flex gap-2">
            {BUSY_LEVELS.map(([value, label, hint]) => (
              <button
                key={value}
                onClick={() => patch({ busyLevel: value })}
                className={`flex-1 rounded-md border px-3 py-2 text-left transition-colors ${
                  settings.busyLevel === value
                    ? "border-nib/60 bg-nib/10"
                    : "border-ink-600 hover:border-ink-500"
                }`}
              >
                <span className="block text-sm text-vellum-200">{label}</span>
                <span className="hint">{hint}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="What it's allowed to do">
          <Switch
            label="Move the mouse"
            hint="Moves the pointer the way a hand would — curved, uneven, never in a straight line."
            checked={settings.actions.moveMouse}
            onChange={(v) => setAction("moveMouse", v)}
          />
          <Switch
            label="Switch between apps"
            hint="Brings one of the apps below to the front, then moves inside its window."
            checked={settings.actions.switchApps}
            onChange={(v) => setAction("switchApps", v)}
          />
          <Switch
            label="Scroll now and then"
            hint="Short scrolls while it's sitting in an app."
            checked={settings.actions.scroll}
            onChange={(v) => setAction("scroll", v)}
          />
          <Switch
            label="Press keys"
            tone="risky"
            hint="Taps Shift only. It never types anything. Off by default — moving the mouse already counts, so this adds nothing."
            checked={settings.actions.pressKeys}
            onChange={(v) => setAction("pressKeys", v)}
          />
          <Switch
            label="Click"
            tone="risky"
            hint="Only on empty desktop space, never on a window. A click lands on whatever is under the pointer, so leave this off unless you have a reason."
            checked={settings.actions.click}
            onChange={(v) => setAction("click", v)}
          />
        </Section>

        <Section
          title="Apps to move between"
          action={
            <button className="hint no-drag hover:text-vellum-200" onClick={refreshApps}>
              refresh
            </button>
          }
        >
          <AppPicker settings={settings} apps={apps} patch={patch} refreshApps={refreshApps} />
        </Section>

        <Section
          title="Behaviour"
          action={
            <button
              className="hint no-drag hover:text-vellum-200"
              onClick={() => window.vellum.scripts.reveal()}
            >
              open folder
            </button>
          }
        >
          <select
            value={settings.script ?? ""}
            onChange={(e) => patch({ script: e.target.value || null })}
            className="w-full rounded border border-ink-600 bg-ink-700 px-2 py-1.5 text-sm text-vellum-200"
          >
            <option value="">Built-in — follows the settings above</option>
            {scripts.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <p className="hint mt-2">
            {settings.script
              ? scripts.find((s) => s.id === settings.script)?.description
                ?? "A script decides what each burst does. It still obeys the switches above."
              : "Move, switch, scroll — mixed at random, on the schedule the busy level sets."}
          </p>
          <p className="hint mt-1">
            Scripts are plain JavaScript files you can edit. Changes take effect on
            the next burst — no restart.
          </p>
        </Section>

        <Section title="How long">
          <div className="flex flex-wrap gap-2">
            {RUN_LENGTHS.map(([label, minutes]) => {
              const on = (settings.runForMinutes ?? null) === minutes;
              return (
                <button
                  key={label}
                  onClick={() => patch({ runForMinutes: minutes })}
                  className={`rounded border px-3 py-1.5 text-xs ${
                    on ? "border-nib/50 bg-nib/10 text-nib"
                       : "border-ink-600 text-vellum-300 hover:border-ink-500"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <p className="hint mt-2">
            {settings.runForMinutes
              ? `Starts the moment you press Start and stops itself after ${formatMinutes(settings.runForMinutes)}.`
              : "Starts the moment you press Start and keeps going until you stop it."}
          </p>
        </Section>

        <Section title="Safety">
          <Switch
            label="Stop when I use the computer"
            hint="Notices real input within a moment and gets out of the way."
            checked={settings.pauseWhenIUseTheComputer}
            onChange={(v) => patch({ pauseWhenIUseTheComputer: v })}
          />
          {settings.pauseWhenIUseTheComputer && (
            <div className="ml-[42px] pb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-vellum-300">Wait</span>
                <input
                  type="number"
                  min={5}
                  max={600}
                  value={settings.resumeAfterSeconds}
                  onChange={(e) => patch({ resumeAfterSeconds: Number(e.target.value) })}
                  className="w-16 rounded border border-ink-600 bg-ink-700 px-2 py-1 text-sm"
                />
                <span className="text-sm text-vellum-300">seconds before picking back up</span>
              </div>
              <p className="hint mt-1">
                Counted from the last thing you touched, so it stays out of the way
                for as long as you keep working.
              </p>
            </div>
          )}
        </Section>

        <Section title="What's visible while it runs">
          <p className="hint mb-2">
            Neither of these puts Vellum in a session log — that only
            records whatever app is in front, and this one never is unless you
            open this window. They matter because a screen capture takes the whole
            screen.
          </p>
          <Switch
            label="Show in the Dock"
            hint="A normal app icon. An illustration tool in the Dock is unremarkable; an app with no presence anywhere is harder to explain."
            checked={settings.showInDock}
            onChange={(v) => patch({ showInDock: v })}
          />
          <Switch
            label="Show in the menu bar"
            tone="risky"
            hint="Adds a status mark that changes as it runs. Off by default — a static icon is one thing, an indicator that visibly reacts is another."
            checked={settings.showInMenuBar}
            onChange={(v) => patch({ showInMenuBar: v })}
          />
          <p className="hint mt-2">
            With both off, nothing on screen is left to click — reopen this window
            with <b className="text-vellum-300">⌘⌥⇧V</b>. The panic stop
            (<b className="text-vellum-300">⌃⌥⌘.</b>) and the HUD toggle
            (<b className="text-vellum-300">⌘⌥V</b>) work regardless, so nothing
            has to come to the front mid-shift.
          </p>
        </Section>

        <Section title="Last hour">
          <ActivityMeter segments={state.segments ?? []} />
        </Section>

        <Section
          title="Log"
          action={
            <button
              className="hint no-drag hover:text-vellum-200"
              onClick={() => window.vellum.settings.reveal()}
            >
              settings file
            </button>
          }
        >
          <LogStream logs={logs} />
        </Section>
      </div>
    </div>
  );
}

function TitleBar({ state, settings, patch }) {
  return (
    <header className="drag flex shrink-0 items-center gap-3 border-b rule px-5 pb-3 pt-8">
      <span className="text-nib">✒︎</span>
      <div className="min-w-0">
        <h1 className="text-sm text-vellum-100">Vellum Studio</h1>
        <StatusDot state={state} settings={settings} />
      </div>
      <button
        onClick={() => patch({ running: !settings.running })}
        className={`no-drag ml-auto rounded-md border px-4 py-1.5 text-sm transition-colors ${
          settings.running
            ? "border-ink-500 text-vellum-300 hover:border-ink-400"
            : "border-live/50 bg-live/10 text-live hover:bg-live/20"
        }`}
      >
        {settings.running ? "Pause" : "Start"}
      </button>
    </header>
  );
}

const RUN_LENGTHS = [
  ["Until I stop it", null],
  ["1 hour", 60],
  ["4 hours", 240],
  ["8 hours", 480],
];

function formatMinutes(m) {
  if (m < 60) return `${m} minutes`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? "" : "s"}`;
}

function AppPicker({ settings, apps, patch, refreshApps }) {
  // Only offer apps that are not already chosen, so the menu shrinks as it is used.
  const chosen = new Set(settings.apps.map((a) => a.bundleId));
  const available = apps.filter((a) => !chosen.has(a.bundleId));

  useEffect(() => { if (!apps.length) refreshApps(); }, []);

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {settings.apps.map((app) => (
          <span
            key={app.bundleId}
            className="flex items-center gap-2 rounded border border-ink-600 bg-ink-700 px-2 py-1 text-xs"
          >
            {app.name}
            <button
              className="text-vellum-400 hover:text-vellum-100"
              onClick={() =>
                patch({ apps: settings.apps.filter((a) => a.bundleId !== app.bundleId) })
              }
            >
              ×
            </button>
          </span>
        ))}
        {settings.apps.length === 0 && (
          <span className="hint">
            none yet — without any, it moves the pointer where it already is
          </span>
        )}
      </div>

      <select
        value=""
        onChange={(e) => {
          const app = apps.find((a) => a.bundleId === e.target.value);
          if (app) patch({ apps: [...settings.apps, { bundleId: app.bundleId, name: app.name }] });
        }}
        className="mt-3 w-full rounded border border-ink-600 bg-ink-700 px-2 py-1.5 text-sm"
      >
        <option value="">Add an app…</option>
        {available.map((a) => (
          <option key={a.bundleId} value={a.bundleId}>
            {a.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function LogStream({ logs }) {
  const ref = useRef(null);

  // Follow the tail, but only when already at the bottom — yanking the view back
  // down while someone is reading history is worse than not following at all.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div
      ref={ref}
      className="h-32 overflow-y-auto rounded border border-ink-600 bg-ink-900 p-2 font-mono text-[11px] leading-relaxed"
    >
      {logs.length === 0 && <span className="text-vellum-400">waiting…</span>}
      {logs.map((e) => (
        <div
          key={e.id ?? `${e.at}-${e.msg}`}
          className={
            e.level === "error" ? "text-held" : e.level === "warn" ? "text-nib" : "text-vellum-300"
          }
        >
          <span className="text-vellum-400">
            {new Date(e.at).toTimeString().slice(0, 8)}{" "}
          </span>
          {e.msg}
        </div>
      ))}
    </div>
  );
}
