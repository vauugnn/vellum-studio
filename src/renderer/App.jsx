import React, { useEffect, useRef } from "react";

import { useStore } from "./store.js";
import {
  Action, Button, Mark, Row, Scrub, Section, Select, StatusDot, Toggle,
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

function AppPicker({ settings, apps, patch, refreshApps }) {
  // Only offer apps that are not already chosen, so the menu shrinks as it is used.
  const chosen = new Set(settings.apps.map((a) => a.bundleId));
  const available = apps.filter((a) => !chosen.has(a.bundleId));

  useEffect(() => { if (!apps.length) refreshApps(); }, []);

  return (
    <div className="pt-1">
      <div className="flex flex-wrap gap-2">
        {settings.apps.map((app) => (
          <span
            key={app.bundleId}
            className="flex items-center gap-1 rounded border border-edge bg-panel py-1 pl-2 pr-1 text-body text-chalk"
          >
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

      <Select
        value=""
        onChange={(e) => {
          const app = apps.find((a) => a.bundleId === e.target.value);
          if (app) patch({ apps: [...settings.apps, { bundleId: app.bundleId, name: app.name }] });
        }}
        className="mt-3"
      >
        <option value="">Add an app…</option>
        {available.map((a) => (
          <option key={a.bundleId} value={a.bundleId}>
            {a.name}
          </option>
        ))}
      </Select>
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
