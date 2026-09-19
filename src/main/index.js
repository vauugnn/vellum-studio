// Electron main: windows, tray, hotkeys, and the bridge between the renderer and
// the executor.
//
// No behaviour lives here. Main owns presentation and lifecycle; the executor
// owns what actually happens, and settings.json is the contract between them.

import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Supervisor } from "./executor/supervisor.js";
import {
  load, save, validate, ensureSettings, ensureScripts, listScripts,
  SETTINGS_PATH, APP_DIR, SCRIPTS_DIR,
} from "./executor/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Set before anything else touches the app identity. This drives the menu-bar
// title, the crash reporter and `app.getName()`.
//
// It does NOT rename the process as other software sees it: anything reading the
// frontmost application goes to the bundle's
// Info.plist, so an unpackaged `npm run dev` always reports "Electron". Only a
// packaged build reads as Vellum Studio. See electron-builder.yml.
app.setName("Vellum Studio");
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!DEV_URL;

/** Opens Privacy & Security straight at the Accessibility list. */
const ACCESSIBILITY_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

let mainWindow = null;
let hud = null;
let tray = null;
let supervisor = null;

/** Last state pushed by the executor, replayed to windows opened later. */
let lastState = { running: false, paused: false };

// ── windows ─────────────────────────────────────────────────────────────────

function loadRenderer(win, route) {
  if (isDev) return win.loadURL(`${DEV_URL}#${route}`);
  return win.loadFile(path.join(HERE, "..", "..", "dist-renderer", "index.html"), { hash: route });
}

function createMainWindow() {
  if (mainWindow) return mainWindow.show();

  mainWindow = new BrowserWindow({
    width: 520,
    height: 760,
    minWidth: 460,
    minHeight: 600,
    show: false,
    title: "Vellum Studio",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#17181A",
    webPreferences: {
      preload: path.join(HERE, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loadRenderer(mainWindow, "/");
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  return mainWindow;
}

function createHud() {
  if (hud) return hud;

  // Larger than the sheet it shows: the transparent margin is where the
  // sheet's shadow falls.
  hud = new BrowserWindow({
    width: 280,
    height: 120,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    // "screen-saver" keeps it above full-screen apps, which is the only level
    // that survives the apps this thing is meant to sit on top of.
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(HERE, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  hud.setAlwaysOnTop(true, "screen-saver");
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  loadRenderer(hud, "/hud");
  return hud;
}

function toggleHud() {
  const w = createHud();
  if (w.isVisible()) w.hide();
  else w.showInactive(); // never steal focus from whatever the user is doing
}

// ── tray ────────────────────────────────────────────────────────────────────

/** The mark at menu-bar size. Packaged builds carry it next to the sidecar in
 *  Contents/Resources; a dev run reads it from the build directory. */
function trayImage() {
  const candidates = [
    path.join(process.resourcesPath ?? "", "tray-16.png"),
    path.join(HERE, "..", "..", "build", "tray-16.png"),
  ];
  for (const p of candidates) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}

function buildTrayMenu() {
  const settings = safeLoad();
  return Menu.buildFromTemplate([
    {
      // From settings, not from executor state. `lastState.running` reports that
      // the executor process is alive, which it always is — reading it here made
      // the menu offer "Pause" on a stopped app.
      label: settings.running ? "Stop" : "Start",
      click: () => patchSettings({ running: !settings.running }),
    },
    { type: "separator" },
    { label: "Show HUD", click: toggleHud },
    { label: "Open Vellum Studio", click: createMainWindow },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

/** Apply the two on-screen surfaces. Both are settings because both end up in
 *  captures, and which of them is acceptable is not ours to decide. */
function applyVisibility(settings) {
  if (settings.showInDock) app.dock?.show();
  else app.dock?.hide();

  if (settings.showInMenuBar && !tray) {
    tray = new Tray(trayImage());
    tray.on("click", () => tray.popUpContextMenu());
  } else if (!settings.showInMenuBar && tray) {
    tray.destroy();
    tray = null;
  }
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const settings = safeLoad();
  const mark = lastState.paused ? "◍" : settings.running ? "◉" : "○";
  // The status rides beside the mark as a text glyph, so it is legible at a
  // glance — which is exactly why this whole item is off by default.
  tray.setTitle(` ${mark}`);
  tray.setToolTip(
    `Vellum Studio — ${settings.running ? "running" : "stopped"}`
  );
  tray.setContextMenu(buildTrayMenu());
}

// ── settings ────────────────────────────────────────────────────────────────

function safeLoad() {
  try {
    return load();
  } catch (e) {
    // A hand-edited file with a typo must not brick the app — surface it and fall
    // back to defaults, which have running off, so a broken file can never leave
    // the app moving in a state nobody chose.
    send("log", { level: "error", msg: `settings.json rejected: ${e.message}`, at: Date.now() });
    return validate({});
  }
}

function patchSettings(patch) {
  const current = safeLoad();
  const next = { ...current, ...patch };

  // Stamp the session as Start is pressed, and clear it on Stop.
  //
  // Done here rather than in the executor because this is the moment the user
  // actually acts. The executor only ever reads the stamp, so a restart mid-run
  // resumes the same session instead of restarting its warm-up.
  if (patch.running !== undefined && patch.running !== current.running) {
    next.startedAt = patch.running ? Date.now() : null;
  }
  try {
    save(next);
    send("settings", next);
    applyVisibility(next);
  } catch (e) {
    send("settingsRejected", { error: e.message });
  }
  return next;
}

// ── renderer bridge ─────────────────────────────────────────────────────────

function send(channel, payload) {
  for (const win of [mainWindow, hud]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function registerIpc() {
  ipcMain.handle("settings:get", () => safeLoad());
  ipcMain.handle("settings:set", (_e, patch) => patchSettings(patch));
  ipcMain.handle("state:get", () => lastState);
  ipcMain.handle("apps:list", async () => {
    // The executor owns the sidecar, so app enumeration goes through it rather
    // than main opening a second connection.
    supervisor?.send({ type: "listApps" });
    return new Promise((resolve) => {
      pendingAppList = resolve;
      setTimeout(() => { if (pendingAppList === resolve) { pendingAppList = null; resolve([]); } }, 5000);
    });
  });
  ipcMain.handle("scripts:list", () => listScripts());
  ipcMain.handle("hud:toggle", toggleHud);
  ipcMain.handle("permissions:open", () => shell.openExternal(ACCESSIBILITY_PANE));
  ipcMain.handle("settings:reveal", () => shell.showItemInFolder(SETTINGS_PATH));
  ipcMain.handle("scripts:reveal", () => shell.openPath(SCRIPTS_DIR));
}

let pendingAppList = null;

/** Attach each app's own icon as a data URL. A miss just leaves the name. */
function withIcons(apps) {
  return Promise.all(apps.map(async (a) => {
    if (!a.path) return a;
    try {
      const icon = await app.getFileIcon(a.path, { size: "small" });
      return { ...a, icon: icon.toDataURL() };
    } catch {
      return a;
    }
  }));
}

// ── executor wiring ─────────────────────────────────────────────────────────

function startExecutor() {
  supervisor = new Supervisor({
    onMessage: (msg) => {
      switch (msg.type) {
        case "state":
          lastState = { ...lastState, ...msg.state };
          send("state", lastState);
          refreshTray();
          break;
        case "appList": {
          const resolve = pendingAppList;
          pendingAppList = null;
          if (resolve) withIcons(msg.apps ?? []).then(resolve);
          break;
        }
        case "log":
          send("log", msg);
          break;
        default:
          send(msg.type, msg);
      }
    },
  });
  supervisor.start();
}

/** Stops everything now. Bound to a hotkey because the moment you want this, you
 *  want it without hunting for a window. */
function panic() {
  patchSettings({ running: false });
  supervisor?.stop();
  send("log", { level: "warn", msg: "panic stop — executor halted", at: Date.now() });
  lastState = { ...lastState, running: false };
  refreshTray();
  // Bring it back up stopped, so the hotkey is a halt and not a teardown.
  setTimeout(() => supervisor?.start(), 2500);
}

// ── lifecycle ───────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => createMainWindow());

  app.whenReady().then(() => {
    // Practice mode is on in the defaults, so a fresh install plans and logs but
    // moves nothing until the user has actually looked at the panel.
    const firstRun = ensureSettings();

    // Seed the bundled behaviour scripts into the user's folder. Only fills
    // gaps, so an edited script survives an update and a deleted one stays gone.
    ensureScripts(
      process.resourcesPath
        ? path.join(process.resourcesPath, "scripts")
        : path.join(HERE, "..", "..", "scripts")
    );

    registerIpc();
    startExecutor();

    globalShortcut.register("CommandOrControl+Alt+V", toggleHud);
    globalShortcut.register("Control+Alt+Command+.", panic);

    // The way back in. With the Dock tile and the menu-bar item both switched
    // off — a combination the settings explicitly allow — there is otherwise no
    // surface left to click, and the panel becomes unreachable without editing
    // settings.json by hand.
    globalShortcut.register("CommandOrControl+Alt+Shift+V", createMainWindow);

    applyVisibility(safeLoad());

    // The window opens on the first run so there is something to set up in, and
    // never again on its own.
    //
    // On every later launch the app hides itself immediately. Launching makes an
    // app frontmost even with no window on screen, and "frontmost" is precisely
    // what a session log records — so an unattended relaunch
    // after a restart would otherwise write Vellum Studio into the log for the
    // few seconds it took to start. Hiding hands focus straight back.
    if (firstRun) createMainWindow();
    else app.hide();

    // Clicking the Dock icon is an explicit request for it, so that still opens.
    app.on("activate", () => createMainWindow());
  });

  // The whole point is to keep running with no window open, so closing the
  // settings panel must not quit — the tray is the app.
  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    globalShortcut.unregisterAll();
    supervisor?.stop();
  });
}
