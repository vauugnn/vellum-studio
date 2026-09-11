// Script host tests. A stub device stands in for the sidecar, so these run
// anywhere and assert what the sandbox actually exposes — in particular that the
// action switches cannot be talked around by a script.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validate } from "./config.js";
import { personalityFor } from "./personality.js";
import { Script, buildContext, parseMetadata } from "./sandbox.js";

const SCRIPTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts"
);

/** Records every command instead of posting anything. */
function stubDevice() {
  const calls = [];
  return {
    calls,
    call(cmd, fields = {}) {
      calls.push({ cmd, ...fields });
      switch (cmd) {
        case "apps.frontWindow": return Promise.resolve({ ok: true, rect: { x: 0, y: 0, w: 800, h: 600 } });
        case "mouse.pos": return Promise.resolve({ ok: true, x: 10, y: 10 });
        case "apps.list": return Promise.resolve({ ok: true, apps: [] });
        default: return Promise.resolve({ ok: true, aborted: false });
      }
    },
  };
}

function harness(overrides = {}, { paused = false } = {}) {
  const cfg = validate({
    apps: [{ bundleId: "com.apple.finder", name: "Finder" }],
    ...overrides,
  });
  const device = stubDevice();
  const ctx = buildContext({
    cfg,
    personality: personalityFor("test-machine"),
    device,
    moveOptions: () => ({}),
    isPaused: () => paused,
  });
  return { cfg, device, ctx };
}

test("metadata is read from the VellumScript header", () => {
  const meta = parseMetadata(
    `// ==VellumScript==
     // @id          demo
     // @name        Demo Script
     // @version     2.1.0
     // ==/VellumScript==
     function vellumRun() {}`,
    "fallback"
  );
  assert.equal(meta.id, "demo");
  assert.equal(meta.name, "Demo Script");
  assert.equal(meta.version, "2.1.0");
});

test("metadata falls back to the filename when the header is missing", () => {
  assert.equal(parseMetadata("function vellumRun() {}", "untitled").id, "untitled");
});

test("a script runs and drives the device", async () => {
  const { device, ctx } = harness();
  const script = new Script({
    id: "t", meta: {},
    source: `async function vellumRun(ctx) {
      await ctx.app.activate("com.apple.finder");
      const rect = await ctx.app.frontWindow("com.apple.finder");
      await ctx.mouse.moveWithin(rect);
    }`,
  });

  await script.run(ctx);
  assert.deepEqual(device.calls.map((c) => c.cmd),
    ["apps.activate", "apps.frontWindow", "mouse.moveWithin"]);
});

test("click is a no-op while the switch is off", async () => {
  const { device, ctx } = harness({ actions: { click: false } });
  const script = new Script({
    id: "t", meta: {}, source: `async function vellumRun(ctx) { await ctx.click(); }`,
  });

  await script.run(ctx);
  assert.equal(device.calls.filter((c) => c.cmd === "click").length, 0,
    "a script reached the click command with the switch off");
});

test("click always demands a safe target when the switch is on", async () => {
  const { device, ctx } = harness({ actions: { click: true } });
  const script = new Script({
    // A script asking to click at a specific point must not be able to opt out
    // of the safe-zone check — that point could be anything on screen.
    id: "t", meta: {},
    source: `async function vellumRun(ctx) { await ctx.click({ x: 400, y: 400, requireSafe: false }); }`,
  });

  await script.run(ctx);
  const click = device.calls.find((c) => c.cmd === "click");
  assert.ok(click, "click did not reach the device");
  assert.equal(click.requireSafe, true, "a script overrode the safe-zone requirement");
});

test("keys off the allowlist never reach the device", async () => {
  const { device, ctx } = harness({
    actions: { pressKeys: true },
    advanced: { keyAllowlist: ["shift"] },
  });
  const script = new Script({
    id: "t", meta: {},
    source: `async function vellumRun(ctx) { await ctx.key("shift"); await ctx.key("return"); }`,
  });

  await script.run(ctx);
  const keys = device.calls.filter((c) => c.cmd === "key");
  assert.equal(keys.length, 1, "a key outside the allowlist was sent");
});

test("a script unwinds when the user has taken over", async () => {
  const { device, ctx } = harness({}, { paused: true });
  const script = new Script({
    id: "t", meta: {},
    source: `async function vellumRun(ctx) {
      await ctx.mouse.moveTo(100, 100);
      await ctx.mouse.moveTo(200, 200);
    }`,
  });

  await assert.rejects(() => script.run(ctx), (e) => e.yielded === true);
  assert.equal(device.calls.length, 0, "a move was posted while paused");
});

test("an aborted stroke unwinds the script", async () => {
  const { ctx, device } = harness();
  device.call = () => Promise.resolve({ ok: true, aborted: true });
  const script = new Script({
    id: "t", meta: {}, source: `async function vellumRun(ctx) { await ctx.mouse.moveTo(1, 1); }`,
  });

  await assert.rejects(() => script.run(ctx), (e) => e.yielded === true);
});

test("a script without an entry point is rejected", async () => {
  const { ctx } = harness();
  const script = new Script({ id: "t", meta: {}, source: `const x = 1;` });
  await assert.rejects(() => script.run(ctx), /no vellumRun\(ctx\) function/);
});

test("scripts cannot reach the host environment", async () => {
  const { ctx } = harness();
  const script = new Script({
    id: "t", meta: {},
    source: `async function vellumRun(ctx) {
      if (typeof require !== "undefined") throw new Error("require is reachable");
      if (typeof process !== "undefined") throw new Error("process is reachable");
    }`,
  });
  await script.run(ctx); // throws inside the script if either is reachable
});

test("the bundled scripts load and expose an entry point", async () => {
  for (const name of ["idle-drift.js", "app-rotation.js"]) {
    const script = Script.fromFile(path.join(SCRIPTS, name));
    assert.ok(script.meta.name, `${name} has no @name`);
    assert.ok(script.meta.version, `${name} has no @version`);

    // Collapse the dwell buckets: the real ones reach 40 seconds, and these
    // scripts dwell after every hop, which turned this into a 64-second test.
    const { ctx, device } = harness({ advanced: { dwellBuckets: [[1, 1, 2]] } });
    await script.run(ctx); // stub device, so this exercises the real control flow
    assert.ok(device.calls.length > 0, `${name} drove nothing`);
  }
});
