// Application and screen geometry.
//
// App activation goes through NSWorkspace rather than AppleScript on purpose:
// `tell application "X" to activate` needs an Apple Events (Automation) grant per
// target app and prompts separately for each one, whereas NSWorkspace activation
// needs no additional TCC grant beyond the Accessibility one we already hold.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - Screens

private func activeDisplayIDs() -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return ids
}

/// All displays in global coordinates (origin top-left, y down). This matches the
/// space CGEvent and the Accessibility API use. NSScreen reports a bottom-left
/// origin, so it is deliberately not used here — mixing the two flips the y axis.
func listScreens() -> [[String: Any]] {
    activeDisplayIDs().map { id in
        let b = CGDisplayBounds(id)
        let mode = CGDisplayCopyDisplayMode(id)
        let scale = mode.map { Double($0.pixelWidth) / max(Double($0.width), 1) } ?? 1.0
        // Widened to Double explicitly: CGFloat does not runtime-cast back out of
        // an `Any` box as Double, which silently breaks any consumer that tries.
        return [
            "id": Int(id),
            "x": Double(b.origin.x), "y": Double(b.origin.y),
            "w": Double(b.size.width), "h": Double(b.size.height),
            "scale": scale,
            "main": CGDisplayIsMain(id) != 0,
        ]
    }
}

/// Bounding box of every display together.
private func screenUnion() -> CGRect {
    activeDisplayIDs().reduce(CGRect.null) { $0.union(CGDisplayBounds($1)) }
}

// MARK: - Running applications

/// Regular (Dock-visible) running apps. Agents and daemons are filtered out —
/// they have no windows to move a cursor into.
/// An app's real icon as base64 PNG at `px` pixels square.
///
/// Drawn here because Electron's own file-icon call returns the generic blank
/// app icon for a .app bundle — NSWorkspace, called from a native process,
/// returns the actual artwork.
func iconPNG(forPath path: String, px: Int = 64) -> String? {
    guard !path.isEmpty,
          let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
    else { return nil }

    let side = NSSize(width: px, height: px)
    rep.size = side
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSWorkspace.shared.icon(forFile: path)
        .draw(in: NSRect(origin: .zero, size: side), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()

    return rep.representation(using: .png, properties: [:])?.base64EncodedString()
}

func listApps() -> [[String: Any]] {
    NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .compactMap { app in
            guard let bundleId = app.bundleIdentifier else { return nil }
            return [
                "bundleId": bundleId,
                "name": app.localizedName ?? bundleId,
                "pid": Int(app.processIdentifier),
                "active": app.isActive,
                "hidden": app.isHidden,
                "icon": iconPNG(forPath: app.bundleURL?.path ?? "") ?? "",
            ]
        }
}

/// Bring an app to the front. Launches it if it is not running and `launch` is set.
func activateApp(bundleId: String, launch: Bool) -> (ok: Bool, error: String?) {
    let running = NSWorkspace.shared.runningApplications
        .first { $0.bundleIdentifier == bundleId }

    if let app = running {
        if app.isHidden { app.unhide() }
        let ok: Bool
        if #available(macOS 14.0, *) {
            ok = app.activate()
        } else {
            ok = app.activate(options: [.activateIgnoringOtherApps])
        }
        return (ok, ok ? nil : "activate refused by the system")
    }

    guard launch else { return (false, "not running") }
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
        return (false, "no application installed for \(bundleId)")
    }
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = true
    let sem = DispatchSemaphore(value: 0)
    var err: String?
    NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, e in
        if let e = e { err = e.localizedDescription }
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 15)
    return (err == nil, err)
}

// MARK: - Window geometry via Accessibility

private func axValue(_ element: AXUIElement, _ attr: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else {
        return nil
    }
    return value
}

/// Frame of an app's frontmost real window, in the same global top-left space as
/// CGEvent.
///
/// This reads the window server's list rather than the Accessibility API. AX
/// looked like the natural choice — the grant is already held — but it does not
/// distinguish Finder's desktop from a Finder window: `kAXFocusedWindow` returns
/// the desktop, full-screen and correctly shaped, so a cursor sent "into Finder"
/// landed on the desktop instead. The subrole attribute that would separate them
/// does not bridge reliably across apps.
///
/// The window list settles it without guessing: normal windows sit at layer 0,
/// the desktop does not, and the list arrives in front-to-back order so the first
/// match is the app's front window. Only bounds are read — window *titles* are
/// what require a Screen Recording grant, and those are never touched.
func frontWindowRect(bundleId: String) -> (rect: CGRect?, error: String?) {
    guard let app = NSWorkspace.shared.runningApplications
        .first(where: { $0.bundleIdentifier == bundleId })
    else { return (nil, "not running") }

    let pid = app.processIdentifier
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        return (nil, "window list unavailable")
    }

    for info in list {
        guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
              let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
              let b = info[kCGWindowBounds as String] as? [String: Any],
              let x = b["X"] as? Double, let y = b["Y"] as? Double,
              let w = b["Width"] as? Double, let h = b["Height"] as? Double,
              // Panels, toolbars and stray helper windows are not somewhere a
              // person parks a cursor.
              w >= 120, h >= 80
        else { continue }
        return (CGRect(x: x, y: y, width: w, height: h), nil)
    }

    return (nil, app.isHidden ? "hidden" : "no window on screen")
}

// MARK: - Safe click zones

/// Rects of every on-screen window, from the window server. Only the *bounds* are
/// read — window titles are what require a Screen Recording grant, and those are
/// never touched here.
private func onScreenWindowRects() -> [CGRect] {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    return list.compactMap { info in
        guard let layer = info[kCGWindowLayer as String] as? Int, layer >= 0,
              let b = info[kCGWindowBounds as String] as? [String: Any],
              let x = b["X"] as? Double, let y = b["Y"] as? Double,
              let w = b["Width"] as? Double, let h = b["Height"] as? Double,
              w > 4, h > 4
        else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }
}

/// A point covered by no window — safe to click without hitting real UI. Returns
/// nil when the screen is fully covered, in which case the caller must not click.
func safePoint(padding: Double) -> CGPoint? {
    let bounds = screenUnion()
    guard !bounds.isNull else { return nil }
    let windows = onScreenWindowRects().map { $0.insetBy(dx: -padding, dy: -padding) }

    // Menu bar strip is never safe — a click there opens a menu.
    let menuBarGuard = bounds.minY + 28

    for _ in 0 ..< 400 {
        let p = CGPoint(x: Double.random(in: bounds.minX + 8 ... bounds.maxX - 8),
                        y: Double.random(in: menuBarGuard ... bounds.maxY - 8))
        if !windows.contains(where: { $0.contains(p) }) { return p }
    }
    return nil
}

// MARK: - Permissions

/// Whether this process holds the Accessibility grant. `prompt: true` shows the
/// system's "open Privacy & Security" dialog once.
func accessibilityTrusted(prompt: Bool) -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
}
