// A ring buffer plus a subscribe hook.
//
// ig-export-extension-2 streamed its log by tailing a file and diffing its size
// every 800ms. That existed because a Chrome extension could not reach into the
// runner's memory; here the UI is one postMessage away, so entries are pushed as
// they happen and the buffer is only there to give a newly-opened window some
// history to render.

const CAPACITY = 500;

const entries = [];
const listeners = new Set();

/** Monotonic id so the UI can ask for "everything after n" without duplicates. */
let nextId = 1;

export function log(level, msg, extra = {}) {
  const entry = { id: nextId++, at: Date.now(), level, msg, ...extra };
  entries.push(entry);
  if (entries.length > CAPACITY) entries.splice(0, entries.length - CAPACITY);

  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      // A broken listener must never take down the run it is observing.
    }
  }
  return entry;
}

export const info = (msg, extra) => log("info", msg, extra);
export const warn = (msg, extra) => log("warn", msg, extra);
export const error = (msg, extra) => log("error", msg, extra);

/** Everything still buffered, oldest first. */
export function history(afterId = 0) {
  return entries.filter((e) => e.id > afterId);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Mirror entries to stdout. Used when the executor runs headless. */
export function echoToConsole() {
  return subscribe((e) => {
    const t = new Date(e.at).toTimeString().slice(0, 8);
    const tag = e.level === "info" ? "" : `[${e.level}] `;
    process.stdout.write(`${t} ${tag}${e.msg}\n`);
  });
}
