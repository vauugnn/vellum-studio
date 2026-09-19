import React, { useEffect, useRef } from "react";

import { useStore } from "./store.js";
import {
  Action, Button, Mark, Row, Scrub, Section, StatusDot, Toggle,
} from "./components.jsx";

export default function App() {
  const {
    settings, state, logs, apps, error, ready,
    init, patch, setAction, refreshApps,
  } = useStore();

  useEffect(() => { init(); }, []);

  if (!ready || !settings) {
    return <div className="rail grid h-full place-items-center">loading</div>;
  }

  return (
    <div className="flex h-full flex-col bg-graphite">
      <TitleBar state={state} settings={settings} patch={patch} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.trusted === false && (
          <div className="mx-5 mt-4 flex items-start gap-3 rounded border border-edge bg-panel px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block text-body text-chalk">Accessibility is off — nothing can move</span>
              <span className="hint mt-0.5 block">
                macOS drops every pointer movement until Vellum Studio is switched on
                under Privacy &amp; Security → Accessibility. It picks up by itself once
                you do.
              </span>
            </span>
            <Button primary className="shrink-0" onClick={() => window.vellum.openAccessibilitySettings()}>
              Open Settings
            </Button>
          </div>
        )}

        {error && (
          <div className="mx-5 mt-4 flex items-start gap-3 rounded border border-edge bg-panel px-3 py-2">
            <span className="rail mt-[2px]">error</span>
            <span className="text-body text-chalk">{error}</span>
          </div>
        )}

        <Section title="What it's allowed to do">
          <Toggle
            label="Move the mouse"
            hint="Moves the pointer the way a hand would — curved, uneven, never in a straight line."
            checked={settings.actions.moveMouse}
            onChange={(v) => setAction("moveMouse", v)}
          />
          <Toggle
            label="Switch between apps"
            hint="Brings one of the apps below to the front, then moves inside its window."
            checked={settings.actions.switchApps}
            onChange={(v) => setAction("switchApps", v)}
          />
          <Toggle
            label="Scroll now and then"
            hint="Short scrolls while it's sitting in an app."
            checked={settings.actions.scroll}
            onChange={(v) => setAction("scroll", v)}
          />
          <Toggle
            label="Press keys"
            hint="Taps Shift only. It never types anything. Off by default — moving the mouse already counts, so this adds nothing."
            checked={settings.actions.pressKeys}
            onChange={(v) => setAction("pressKeys", v)}
          />
          <Toggle
            label="Click"
            hint="Only on empty desktop space, never on a window. A click lands on whatever is under the pointer, so leave this off unless you have a reason."
            checked={settings.actions.click}
            onChange={(v) => setAction("click", v)}
          />
        </Section>

        <Section
          title="Apps to move between"
          action={<Action onClick={refreshApps}>refresh</Action>}
        >
          <AppPicker settings={settings} apps={apps} patch={patch} refreshApps={refreshApps} />
        </Section>

        <Section title="When you use the computer">
          <Row
            label="Picks back up after"
            hint="It freezes the moment you touch the keyboard or trackpad and stays frozen for as long as you keep working. Counted from the last thing you touched."
          >
            <Scrub
              value={settings.resumeAfterSeconds}
              min={5}
              max={600}
              unit="s"
              onChange={(v) => patch({ resumeAfterSeconds: v })}
            />
          </Row>
          <p className="hint">
            Drag the number sideways to change it — Shift for fine, Option for
            coarse. Click it to type.
          </p>
        </Section>

        <Section
          title="Log"
          action={<Action onClick={() => window.vellum.settings.reveal()}>settings file</Action>}
        >
          <LogStream logs={logs} />
        </Section>
      </div>
    </div>
  );
}

function TitleBar({ state, settings, patch }) {
  // The left padding clears the traffic lights, which the inset title bar
  // style leaves in place over our own chrome.
  return (
    <header className="drag flex h-11 shrink-0 items-center gap-3 border-b border-seam bg-panel pl-[80px] pr-4">
      <Mark size={16} className="shrink-0" />
      <h1 className="shrink-0 text-body font-semibold tracking-[-0.02em] text-chalk">Vellum Studio</h1>
      <StatusDot state={state} settings={settings} />
      <Button
        primary={!settings.running && state.trusted !== false}
        className="ml-auto shrink-0"
        onClick={() => patch({ running: !settings.running })}
      >
        {settings.running ? "Stop" : "Start"}
      </Button>
    </header>
  );
}

const iconSrc = (b64) => (b64 ? `data:image/png;base64,${b64}` : null);

function AppIcon({ b64 }) {
  const src = iconSrc(b64);
  // A fixed box either way, so a chip without an icon does not shift the row.
  return src
    ? <img src={src} alt="" className="h-4 w-4 shrink-0" />
    : <span className="h-4 w-4 shrink-0" />;
}

function AppPicker({ settings, apps, patch, refreshApps }) {
  // Only offer apps that are not already chosen, so the menu shrinks as it is used.
  const chosen = new Set(settings.apps.map((a) => a.bundleId));
  const available = apps.filter((a) => !chosen.has(a.bundleId));
  // Icons come with the running-app list; a chosen app that is closed right
  // now simply shows its name.
  const iconOf = new Map(apps.map((a) => [a.bundleId, a.icon]));

  useEffect(() => { if (!apps.length) refreshApps(); }, []);

  return (
    <div className="pt-1">
      <div className="flex flex-wrap gap-2">
        {settings.apps.map((app) => (
          <span
            key={app.bundleId}
            className="flex items-center gap-1.5 rounded border border-edge bg-panel py-1 pl-2 pr-1 text-body text-chalk"
          >
            <AppIcon b64={iconOf.get(app.bundleId)} />
            {app.name}
            <button
              aria-label={`Remove ${app.name}`}
              className="rail px-1 hover:text-vermilion"
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

      <AppMenu
        apps={available}
        onOpen={refreshApps}
        onPick={(a) => patch({ apps: [...settings.apps, { bundleId: a.bundleId, name: a.name }] })}
      />
    </div>
  );
}

/**
 * The "Add an app" list. A native <select> cannot draw images in its options, so
 * this is a small listbox of our own: opens on click, refreshes the running-app
 * list as it opens, closes on a pick, Escape, or a click anywhere else.
 */
function AppMenu({ apps, onPick, onOpen }) {
  const [open, setOpen] = React.useState(false);
  const root = useRef(null);

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!root.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={root} className="relative mt-3">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { if (!open) onOpen(); setOpen(!open); }}
        className={`well flex h-8 w-full items-center justify-between px-2 text-left text-body text-chalk hover:border-dust ${open ? "border-ultra" : ""}`}
      >
        Add an app…
        <span className="rail">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 z-10 mt-1 max-h-60 overflow-y-auto rounded border border-edge bg-panel py-1 shadow-sheet"
        >
          {apps.length === 0 && <li className="hint px-2 py-1.5">nothing else is open</li>}
          {apps.map((a) => (
            <li key={a.bundleId} role="option">
              <button
                type="button"
                onClick={() => { onPick(a); setOpen(false); }}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-body text-chalk hover:bg-seam"
              >
                <AppIcon b64={a.icon} />
                {a.name}
              </button>
            </li>
          ))}
        </ul>
      )}
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
    <div ref={ref} className="well mt-2 h-36 overflow-y-auto p-2 font-mono text-rail leading-4">
      {logs.length === 0 && <span className="text-dust">waiting</span>}
      {logs.map((e) => (
        <div
          key={e.id ?? `${e.at}-${e.msg}`}
          className={
            e.level === "error" ? "font-medium text-chalk"
              : e.level === "warn" ? "text-chalk"
                : "text-ash"
          }
        >
          <span className="text-dust">
            {new Date(e.at).toTimeString().slice(0, 8)}{" "}
          </span>
          {e.msg}
        </div>
      ))}
    </div>
  );
}
