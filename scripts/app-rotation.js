// ==VellumScript==
// @id          app-rotation
// @name        App Rotation
// @description Works through the configured apps in turn, spending a stretch in
//              each before moving on — the shape of someone checking in on a few
//              things rather than staring at one.
// @version     1.0.0
// ==/VellumScript==

async function vellumRun(ctx) {
  const apps = ctx.config.apps;
  if (!apps.length) {
    ctx.log("no apps configured");
    return;
  }

  // Start somewhere different each run, so a restart mid-morning does not always
  // replay the same order.
  const start = ctx.rand(0, apps.length - 1);

  for (let i = 0; i < apps.length; i++) {
    const app = apps[(start + i) % apps.length];

    await ctx.app.activate(app.bundleId);
    const rect = await ctx.app.frontWindow(app.bundleId);
    if (!rect) {
      ctx.log(`${app.name} has no window — skipping`);
      continue;
    }

    ctx.log(`in ${app.name}`);

    // A first move to orient, then a couple of smaller ones while "reading".
    await ctx.mouse.moveWithin(rect, { pad: 70 });
    await ctx.sleep(ctx.dwell());

    for (let k = 0; k < ctx.rand(1, 3); k++) {
      await ctx.mouse.moveWithin(rect, { pad: 140, curve: 1.5, tremor: 1.2 });
      if (ctx.chance(0.5)) await ctx.mouse.scroll(-ctx.rand(2, 5));
      await ctx.sleep(ctx.dwell());
      ctx.yieldIfHuman();
    }

    // Pause between apps — switching instantly from one to the next reads as a
    // script even when each individual move does not.
    await ctx.sleep(ctx.rand(2000, 6000));
    ctx.yieldIfHuman();
  }
}
