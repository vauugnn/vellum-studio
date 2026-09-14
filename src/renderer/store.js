import { create } from "zustand";

// Single store for both windows. Settings are never mutated locally and then
// synced — every change goes to main, which validates and saves, and the store
// only ever holds what came back. That way a value the validator rejects never
// appears in the UI as though it took.

const MAX_LOG = 200;
let initStarted = false;

export const useStore = create((set, get) => ({
  settings: null,
  state: { running: false, paused: false },
  logs: [],
  apps: [],
  error: null,
  ready: false,

  async init() {
    // Effects mount twice under StrictMode in development, and the IPC
    // listeners below have no unsubscribe — a second run doubled every log
    // line. One subscription per window, whatever React does.
    if (initStarted) return;
    initStarted = true;

    const [settings, state] = await Promise.all([
      window.vellum.settings.get(),
      window.vellum.state.get(),
    ]);
    set({ settings, state, ready: true });
    get().refreshScripts();

    window.vellum.settings.onChange((s) => set({ settings: s, error: null }));
    window.vellum.settings.onRejected(({ error }) => set({ error }));
    window.vellum.state.onChange((s) => set({ state: { ...get().state, ...s } }));
    window.vellum.logs.onEntry((entry) =>
      set((prev) => ({ logs: [...prev.logs, entry].slice(-MAX_LOG) }))
    );
  },

  /** Patch settings through main; the store updates when it answers. */
  async patch(patch) {
    const saved = await window.vellum.settings.patch(patch);
    if (saved) set({ settings: saved, error: null });
  },

  /** Convenience for the nested action switches. */
  async setAction(name, value) {
    const { settings } = get();
    if (!settings) return;
    await get().patch({ actions: { ...settings.actions, [name]: value } });
  },

  async refreshApps() {
    set({ apps: await window.vellum.apps.list() });
  },

  scripts: [],
  async refreshScripts() {
    set({ scripts: await window.vellum.scripts.list() });
  },

}));
