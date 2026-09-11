// Preload. CommonJS on purpose — preload scripts run before the ESM loader is
// available in the renderer's context.
//
// This is the entire surface the renderer gets. No ipcRenderer, no require, no
// direct settings path: the renderer can read and patch settings, subscribe to
// state and log events, and trigger a small set of named actions. Nothing else.

const { contextBridge, ipcRenderer } = require("electron");

/** Wrap a push channel so the renderer gets an unsubscribe rather than a leak. */
function channel(name) {
  return (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  };
}

contextBridge.exposeInMainWorld("vellum", {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    /** Shallow patch, validated in main; returns the settings as saved. */
    patch: (patch) => ipcRenderer.invoke("settings:set", patch),
    reveal: () => ipcRenderer.invoke("settings:reveal"),
    onChange: channel("settings"),
    onRejected: channel("settingsRejected"),
  },

  state: {
    get: () => ipcRenderer.invoke("state:get"),
    onChange: channel("state"),
  },

  logs: {
    onEntry: channel("log"),
  },

  apps: {
    list: () => ipcRenderer.invoke("apps:list"),
  },

  scripts: {
    list: () => ipcRenderer.invoke("scripts:list"),
    reveal: () => ipcRenderer.invoke("scripts:reveal"),
  },

  hud: {
    toggle: () => ipcRenderer.invoke("hud:toggle"),
  },

  openAccessibilitySettings: () => ipcRenderer.invoke("permissions:open"),
});
