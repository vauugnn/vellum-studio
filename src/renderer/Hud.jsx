import React, { useEffect, useState } from "react";

import { useStore } from "./store.js";
import { Mark } from "./components.jsx";

// The always-on-top strip. It answers one question — is this working right now,
// and when does it act next — without needing the panel open. Everything else
// belongs in the panel.

export default function Hud() {
  const { state, settings, logs, init, ready } = useStore();
  const [now, setNow] = useState(Date.now());

  useEffect(() => { init(); }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  if (!ready) return null;

  // A hold only means anything while running; the deadline outlives Stop.
  const paused = !!settings?.running && state.pausedUntil != null && now < state.pausedUntil;
  const [dot, word] = paused
    ? ["bg-dust", "paused"]
    : settings?.running
      ? ["bg-ultra", "running"]
      : ["border border-edge", "stopped"];

  const last = [...logs].reverse().find((e) => e.level === "info");

  // The window is larger than the sheet so the shadow has room to fall.
  return (
    <div className="h-full w-full p-6">
      <div className="drag flex h-full w-full flex-col justify-center gap-1 rounded border border-edge bg-panel px-3 shadow-sheet">
        <div className="flex items-center gap-2">
          <Mark size={16} className="shrink-0" />
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
          <span className="rail text-chalk">{word}</span>

          {paused && (
            <span className="ml-auto font-mono text-rail text-chalk">
              {Math.max(0, Math.ceil((state.pausedUntil - now) / 1000))}s
            </span>
          )}
          {!paused && state.currentApp && (
            <span className="ml-auto truncate text-rail text-dust">{state.currentApp}</span>
          )}
        </div>

        <div className="truncate font-mono text-rail text-dust">
          {paused ? "waiting for you to stop" : (last?.msg ?? "—")}
        </div>
      </div>
    </div>
  );
}
