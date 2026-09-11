import React, { useEffect, useState } from "react";

import { useStore } from "./store.js";

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

  const paused = state.paused && now < state.pausedUntil;
  const [tone, word] = paused
    ? ["bg-held", "paused"]
    : settings?.running
      ? ["bg-live", "running"]
      : ["bg-vellum-400", "stopped"];

  const last = [...logs].reverse().find((e) => e.level === "info");

  return (
    <div className="drag h-full w-full select-none rounded-xl border border-ink-600 bg-ink-900/90 px-3 py-2 backdrop-blur">
      <div className="flex items-center gap-2">
        <span className="text-sm text-nib">✒︎</span>
        <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
        <span className="text-[11px] uppercase tracking-wider text-vellum-200">{word}</span>

        {paused && (
          <span className="ml-auto font-mono text-[11px] text-held">
            {Math.max(0, Math.ceil((state.pausedUntil - now) / 1000))}s
          </span>
        )}
        {!paused && state.currentApp && (
          <span className="ml-auto truncate text-[11px] text-vellum-400">{state.currentApp}</span>
        )}
      </div>

      <div className="mt-1 truncate font-mono text-[10px] text-vellum-400">
        {paused ? "waiting for you to stop" : (last?.msg ?? "—")}
      </div>
    </div>
  );
}
