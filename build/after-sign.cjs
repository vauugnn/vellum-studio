// Sign the Swift sidecar, then verify the whole bundle.
//
// electron-builder signs the app and everything it recognises as executable, but
// extraResources are copied in as opaque files — `vellum-input` lands in
// Contents/Resources unsigned. Two things break as a result:
//
//   1. Notarization rejects the bundle. Every Mach-O inside a hardened-runtime
//      app has to carry a signature, and the sidecar is a Mach-O.
//   2. The Accessibility grant attaches to the wrong thing. TCC identifies the
//      responsible process by code signature; an unsigned helper is its own
//      identity, so the user would be asked to grant permission to a binary
//      called "vellum-input" rather than to Vellum Studio — and would have to
//      re-grant it on every rebuild, since an unsigned binary's identity is its
//      path and hash.
//
// Signing it with the same Developer ID as the app fixes both.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * The identity to sign the sidecar with.
 *
 * electron-builder finds its own identity by searching the keychain and does not
 * hand it to this hook, so the search is repeated here rather than depending on
 * an env var that is only set in CI — locally nothing sets CSC_NAME, and the
 * helper would have silently shipped unsigned.
 */
function resolveIdentity(packager) {
  if (process.env.CSC_NAME) return process.env.CSC_NAME;
  if (packager.platformSpecificBuildOptions.identity) {
    return packager.platformSpecificBuildOptions.identity;
  }

  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    });
    // Prefer Developer ID — a Development cert signs fine locally but is
    // rejected by notarization and by Gatekeeper on any other machine.
    const line = out.split("\n").find((l) => l.includes("Developer ID Application"));
    return line ? line.match(/"([^"]+)"/)?.[1] ?? null : null;
  } catch {
    return null;
  }
}

exports.default = async function afterSign(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  if (electronPlatformName !== "darwin") return;

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const sidecar = path.join(appPath, "Contents", "Resources", "vellum-input");

  if (!fs.existsSync(sidecar)) {
    throw new Error(
      `sidecar missing from the bundle at ${sidecar} — run "npm run build:native" before packaging`
    );
  }

  const identity = resolveIdentity(packager);
  if (!identity) {
    // Unsigned builds are legitimate for local testing; say so rather than
    // failing, but never let it pass silently as though it had been signed.
    console.warn("  • no Developer ID found — leaving vellum-input unsigned (local build only)");
    return;
  }

  const entitlements = path.resolve("build/entitlements.mac.plist");

  console.log(`  • signing vellum-input with "${identity}"`);
  execFileSync("codesign", [
    "--force",
    "--sign", identity,
    "--options", "runtime",
    "--timestamp",
    "--entitlements", entitlements,
    sidecar,
  ], { stdio: "inherit" });

  // Re-sign the app itself. Modifying a nested binary invalidates the outer
  // signature that was computed over it, so the bundle has to be sealed again.
  console.log("  • re-sealing the app bundle");
  execFileSync("codesign", [
    "--force",
    "--sign", identity,
    "--options", "runtime",
    "--timestamp",
    "--entitlements", entitlements,
    "--deep",
    appPath,
  ], { stdio: "inherit" });

  // Fail the build here rather than at notarization, where the error arrives
  // twenty minutes later as an opaque server-side rejection.
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    { stdio: "inherit" });
};
