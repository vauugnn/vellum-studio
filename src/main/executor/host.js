// Entry point inside the utilityProcess.
//
// Wraps the same Runner the headless CLI uses — the executor has no idea whether
// it was started by Electron or by `node runner.js`, which is what keeps the
// headless path a real debugging tool rather than a second implementation that
// drifts.

import { Runner } from "./runner.js";
import { save } from "./config.js";
import * as logger from "./log.js";

let runner = null;

const post = (msg) => process.parentPort?.postMessage(msg);

logger.subscribe((entry) => post({ type: "log", ...entry }));

// Also to stdout in development. The executor's log used to go only to the
// renderer, so `npm run dev` showed nothing about what the thing was actually
// doing — diagnosing anything meant re-running it headless to get its voice back.
if (!process.env.NODE_ENV || process.env.NODE_ENV === "development") {
  logger.echoToConsole();
}

async function start() {
  runner = new Runner({
    onState: (state) => post({ type: "state", state }),
  });

  post({ type: "state", state: runner.state });

  try {
    await runner.start();
  } catch (e) {
    logger.error(`executor failed to start: ${e.message}`);
    process.exit(1);
  }
}

process.parentPort?.on("message", async ({ data: msg }) => {
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "shutdown":
      await runner?.stop();
      process.exit(0);
      break;

    case "settings":
      // The renderer edits settings; the file stays the single source of truth
      // and the run loop picks the change up on its next pass.
      try {
        save(msg.settings);
        post({ type: "settingsSaved", settings: msg.settings });
      } catch (e) {
        post({ type: "settingsRejected", error: e.message });
      }
      break;

    case "history":
      post({ type: "history", entries: logger.history(msg.afterId ?? 0) });
      break;

    case "listApps":
      // The app picker needs what is running. The executor already holds the
      // only connection to the sidecar, so the query is relayed rather than main
      // opening a second one.
      try {
        post({ type: "appList", apps: await runner.listApps() });
      } catch (e) {
        logger.warn(`could not list apps: ${e.message}`);
        post({ type: "appList", apps: [] });
      }
      break;

    default:
      break;
  }
});

start();
