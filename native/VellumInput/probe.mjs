#!/usr/bin/env node
// Dev harness for the sidecar — drives it with framed JSON straight from a
// terminal, with no Electron and no executor in the way. This is the fastest way
// to tell whether a problem is in the Swift layer or above it.
//
//   node native/VellumInput/probe.mjs caps
//   node native/VellumInput/probe.mjs apps
//   node native/VellumInput/probe.mjs pos
//   node native/VellumInput/probe.mjs move 900 500          # practice mode
//   node native/VellumInput/probe.mjs move 900 500 --live   # really moves
//   node native/VellumInput/probe.mjs window com.apple.finder
//   node native/VellumInput/probe.mjs guard --live          # then move your mouse

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist", "vellum-input");
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const args = argv.filter((a) => a !== "--live");
const [cmd, ...rest] = args;

const child = spawn(BIN, { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 1;
const pending = new Map();

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([header, body]));
}

function call(cmd, fields = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, cmd, ...fields });
  });
}

// Same framing as the Swift side, mirrored: [uint32 LE length][utf8 JSON].
let buf = Buffer.alloc(0);
child.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
    buf = buf.subarray(4 + len);
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else {
      console.log("←", JSON.stringify(msg));
    }
  }
});

const show = (label, v) => console.log(label, JSON.stringify(v, null, 2));

async function main() {
  const caps = await call("caps", { practiceMode: !live, prompt: cmd === "caps" });
  if (cmd !== "caps") {
    console.log(
      `sidecar v${caps.version}  trusted=${caps.trusted}  guard=${caps.guard}  ` +
        `mode=${live ? "LIVE" : "practice"}`
    );
    if (!caps.trusted) {
      console.log("! Accessibility not granted — events will not reach the system.");
    }
  }

  switch (cmd) {
    case "caps":
      show("caps", caps);
      break;

    case "apps": {
      const r = await call("apps.list");
      for (const a of r.apps) {
        console.log(`  ${a.active ? "▸" : " "} ${a.name.padEnd(24)} ${a.bundleId}`);
      }
      break;
    }

    case "pos":
      show("pos", await call("mouse.pos"));
      break;

    case "move": {
      const [x, y] = rest.map(Number);
      show("moveTo", await call("mouse.moveTo", { x, y }));
      break;
    }

    case "window": {
      const bundleId = rest[0];
      await call("apps.activate", { bundleId });
      show("frontWindow", await call("apps.frontWindow", { bundleId }));
      break;
    }

    case "into": {
      // The real motion path: activate an app, read its window, move inside it.
      const bundleId = rest[0];
      show("activate", await call("apps.activate", { bundleId }));
      const w = await call("apps.frontWindow", { bundleId });
      if (!w.ok) return show("frontWindow", w);
      show("moveWithin", await call("mouse.moveWithin", { rect: w.rect, pad: 60 }));
      break;
    }

    case "scroll":
      show("scroll", await call("scroll", { dy: Number(rest[0] ?? -4), ms: 400 }));
      break;

    case "safe":
      show("safePoint", await call("safePoint", { padding: 16 }));
      break;

    case "guard":
      console.log("watching for real input for 20s — move your mouse or type…");
      await call("guard", { on: true });
      await new Promise((r) => setTimeout(r, 20_000));
      break;

    default:
      console.log("commands: caps apps pos move <x> <y> window <bundleId> into <bundleId> scroll [dy] safe guard");
  }

  child.kill();
  process.exit(0);
}

main();
