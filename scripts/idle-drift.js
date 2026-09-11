// ==VellumScript==
// @id          idle-drift
// @name        Idle Drift
// @description Settles into one app and drifts around inside it, the way a
//              cursor moves while someone is reading rather than working.
// @version     1.0.0
// ==/VellumScript==

// Scripts define vellumRun(ctx) at global scope; the host calls it with the
// runtime. Nothing is imported — everything reachable is on ctx.

async function vellumRun(ctx) {
  const app = ctx.pick(ctx.config.apps);
  if (!app) {
    ctx.log("no apps configured — drifting on screen instead");
    return;
  }

  await ctx.app.activate(app.bundleId);
  const rect = await ctx.app.frontWindow(app.bundleId);
  if (!rect) {
    ctx.log(`${app.name} has no readable window`);
    return;
  }

  const hops = ctx.rand(3, 7);
  ctx.log(`drifting in ${app.name} for ${hops} hops`);

  for (let i = 0; i < hops; i++) {
    // Tighter padding than a deliberate move: a reading cursor stays in the
    // middle of the content rather than touching the chrome.
    await ctx.mouse.moveWithin(rect, { pad: 120, curve: 1.4, tremor: 1.3 });
    await ctx.sleep(ctx.dwell());

    if (ctx.chance(0.45)) {
      await ctx.mouse.scroll(ctx.chance(0.8) ? -ctx.rand(2, 5) : ctx.rand(1, 3));
      await ctx.sleep(ctx.rand(400, 1800));
    }

    ctx.yieldIfHuman();
  }
}
