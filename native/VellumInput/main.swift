// VellumInput — the "hands" sidecar for Vellum Studio.
//
// Speaks framed JSON on stdio (see Proto.swift) and turns commands into real
// macOS input events. Everything requiring Accessibility, AppKit or CoreGraphics
// lives on this side of the boundary; the executor above it is plain Node.
//
// Two dispatch lanes:
//   - queries (caps, apps.list, mouse.pos, guard, abort) answer inline, so they
//     stay responsive while a stroke is in flight;
//   - actions (moves, scrolls, clicks, activations) run on a serial queue, so
//     they never overlap and an activate always precedes the move that follows it.

import AppKit
import CoreGraphics
import Foundation

let VERSION = "0.1.0"

let actionQueue = DispatchQueue(label: "studio.vellum.input.actions", qos: .userInitiated)

private func num(_ v: Any?) -> Double? {
    if let d = v as? Double { return d }
    if let i = v as? Int { return Double(i) }
    if let n = v as? NSNumber { return n.doubleValue }
    return nil
}

private func handleQuery(_ msg: [String: Any], _ cmd: String, _ id: Any?) -> Bool {
    switch cmd {
    case "ping":
        reply(id, ["ok": true])

    case "caps":
        let trusted = accessibilityTrusted(prompt: (msg["prompt"] as? Bool) ?? false)
        let guardOK = trusted ? startGuard() : false
        reply(id, [
            "ok": true,
            "version": VERSION,
            "trusted": trusted,
            "guard": guardOK,
            "screens": listScreens(),
        ])

    case "apps.list":
        reply(id, ["ok": true, "apps": listApps()])

    case "mouse.pos":
        let p = mousePosition()
        reply(id, ["ok": true, "x": p.x, "y": p.y])

    case "safePoint":
        if let p = safePoint(padding: num(msg["padding"]) ?? 12) {
            reply(id, ["ok": true, "x": p.x, "y": p.y])
        } else {
            reply(id, ["ok": false, "error": "no uncovered screen area"])
        }

    case "guard":
        let on = (msg["on"] as? Bool) ?? true
        let ok = on ? startGuard() : { stopGuard(); return true }()
        reply(id, ["ok": ok])

    case "abort":
        // Cuts the stroke in flight — the yield path when the user takes over.
        abortRequested = true
        reply(id, ["ok": true])

    case "quit":
        reply(id, ["ok": true])
        exit(0)

    default:
        return false
    }
    return true
}

private func handleAction(_ msg: [String: Any], _ cmd: String, _ id: Any?) {
    switch cmd {
    case "mouse.moveTo":
        guard let x = num(msg["x"]), let y = num(msg["y"]) else {
            return replyError(id, "x and y are required")
        }
        abortRequested = false
        let r = humanMove(to: CGPoint(x: x, y: y), MoveOptions.from(msg))
        // Echo the target rather than the live pointer position: in practice mode
        // nothing actually moved, and reporting the real cursor would make the
        // log read as though a stroke had landed somewhere it never went.
        reply(id, ["ok": true, "x": x, "y": y,
                   "samples": r.samples, "actualMs": r.ms, "aborted": abortRequested])

    case "mouse.moveWithin":
        // Pick a landing point inside a window rect. Done here rather than in the
        // executor so a move is still one round trip.
        guard let r = msg["rect"] as? [String: Any],
              let rx = num(r["x"]), let ry = num(r["y"]),
              let rw = num(r["w"]), let rh = num(r["h"])
        else { return replyError(id, "rect {x,y,w,h} is required") }

        let pad = min(num(msg["pad"]) ?? 60, min(rw, rh) / 2 - 4)
        guard rw - 2 * pad > 1, rh - 2 * pad > 1 else {
            return replyError(id, "rect too small for the requested padding")
        }
        // Bias toward the middle: a cursor parked dead against a window edge is
        // not where a person leaves it.
        let bias = { (lo: Double, hi: Double) -> Double in
            let a = Double.random(in: lo ... hi), b = Double.random(in: lo ... hi)
            return (a + b) / 2
        }
        let target = CGPoint(x: bias(rx + pad, rx + rw - pad),
                             y: bias(ry + pad, ry + rh - pad))
        abortRequested = false
        let res = humanMove(to: target, MoveOptions.from(msg))
        reply(id, ["ok": true, "x": target.x, "y": target.y,
                   "samples": res.samples, "actualMs": res.ms, "aborted": abortRequested])

    case "scroll":
        let dx = Int(num(msg["dx"]) ?? 0)
        let dy = Int(num(msg["dy"]) ?? 0)
        let device = ScrollDevice(rawValue: (msg["device"] as? String) ?? "") ?? .trackpad
        humanScroll(dx: dx, dy: dy, ms: num(msg["ms"]) ?? 320, device: device)
        reply(id, ["ok": true])

    case "click":
        // Refuse anywhere a real window could receive the click. The executor
        // gates this too; the duplicate check is deliberate — a click landing on
        // live UI is the one action here that can destroy the user's work.
        let padding = num(msg["padding"]) ?? 12
        var point: CGPoint?
        if let x = num(msg["x"]), let y = num(msg["y"]) { point = CGPoint(x: x, y: y) }
        if (msg["requireSafe"] as? Bool) ?? true {
            guard let safe = safePoint(padding: padding) else {
                return replyError(id, "no safe area to click — skipped")
            }
            point = point ?? safe
            // A caller-supplied point is not trusted; re-derive from safePoint.
            point = safe
        }
        click(button: (msg["button"] as? String) ?? "left", at: point)
        reply(id, ["ok": true, "x": point?.x ?? 0, "y": point?.y ?? 0])

    case "key":
        guard let code = num(msg["keyCode"]) else { return replyError(id, "keyCode is required") }
        pressKey(keyCode: Int(code), flags: UInt64(num(msg["flags"]) ?? 0))
        reply(id, ["ok": true])

    case "apps.activate":
        guard let bundleId = msg["bundleId"] as? String else {
            return replyError(id, "bundleId is required")
        }
        let r = activateApp(bundleId: bundleId, launch: (msg["launch"] as? Bool) ?? false)
        if r.ok {
            // Activation is asynchronous inside the window server; without this
            // the frontWindow query that usually follows races it.
            Thread.sleep(forTimeInterval: Double.random(in: 0.25 ... 0.55))
        }
        reply(id, ["ok": r.ok, "error": r.error as Any])

    case "apps.frontWindow":
        guard let bundleId = msg["bundleId"] as? String else {
            return replyError(id, "bundleId is required")
        }
        let r = frontWindowRect(bundleId: bundleId)
        if let rect = r.rect {
            reply(id, ["ok": true, "rect": ["x": rect.origin.x, "y": rect.origin.y,
                                            "w": rect.size.width, "h": rect.size.height]])
        } else {
            replyError(id, r.error ?? "unknown")
        }

    default:
        replyError(id, "unknown cmd: \(cmd)")
    }
}

// MARK: - Boot

readFrames { msg in
    guard let cmd = msg["cmd"] as? String else { return }
    let id = msg["id"]
    if handleQuery(msg, cmd, id) { return }
    actionQueue.async { handleAction(msg, cmd, id) }
}

// AppKit needs an activation policy set before NSWorkspace behaves; .accessory
// keeps this helper out of the Dock and the ⌘-Tab switcher.
NSApplication.shared.setActivationPolicy(.accessory)

send([
    "type": "ready",
    "version": VERSION,
    "trusted": accessibilityTrusted(prompt: false),
    "pid": ProcessInfo.processInfo.processIdentifier,
])

CFRunLoopRun()
