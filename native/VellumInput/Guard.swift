// Human-input detection.
//
// A passive (listen-only) event tap watches the same event stream we post into.
// Our own events carry MAGIC in eventSourceUserData; anything arriving without it
// came from the real keyboard or trackpad, which means the user has taken over and
// the executor must get out of the way immediately.
//
// This is the mechanism behind the "Stop when I use the computer" switch.

import CoreGraphics
import Foundation

private var tapPort: CFMachPort?
private var tapSource: CFRunLoopSource?
private var lastEmit = Date.distantPast

/// Minimum spacing between humanInput notifications. A single hand movement
/// produces hundreds of events; the executor only needs to hear about it once.
private let emitThrottle: TimeInterval = 1.0

private let ownPid = Int64(ProcessInfo.processInfo.processIdentifier)

/// How long after one of our own posts we keep treating arriving events as ours.
///
/// Needed because scroll wheel events do not survive the trip intact: the window
/// server re-synthesizes them, and what reaches the tap carries neither our
/// userData stamp nor our pid. Measured false positives without this: every
/// scroll burst we emit. The cost is that genuine user input landing inside the
/// window is missed, but only until their next event ~10 ms later.
private let selfEmitWindowMs: Double = 250

/// Three independent ways to recognise our own input, because no single one holds
/// for every event type: the userData stamp (mouse, keys), the posting process id,
/// and a recency window (scroll, and anything else the system rewrites).
private func isOurs(_ event: CGEvent) -> Bool {
    if event.getIntegerValueField(.eventSourceUserData) == MAGIC { return true }
    if event.getIntegerValueField(.eventSourceUnixProcessID) == ownPid { return true }
    if msSinceOurLastPost() < selfEmitWindowMs { return true }
    return false
}

private let tapCallback: CGEventTapCallBack = { _, type, event, _ in
    // The system disables a tap that misbehaves; re-arm rather than going deaf.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let port = tapPort { CGEvent.tapEnable(tap: port, enable: true) }
        return Unmanaged.passUnretained(event)
    }

    if !isOurs(event) {
        let now = Date()
        if now.timeIntervalSince(lastEmit) >= emitThrottle {
            lastEmit = now
            let kind: String
            switch type {
            case .keyDown, .flagsChanged: kind = "key"
            case .scrollWheel: kind = "scroll"
            default: kind = "mouse"
            }
            send(["type": "humanInput", "kind": kind, "at": now.timeIntervalSince1970 * 1000])
        }
    }
    return Unmanaged.passUnretained(event)
}

/// Start watching for real user input. Returns false when the tap could not be
/// created, which in practice always means the Accessibility grant is missing.
@discardableResult
func startGuard() -> Bool {
    guard tapPort == nil else { return true }

    let mask: CGEventMask =
        (1 << CGEventType.mouseMoved.rawValue) |
        (1 << CGEventType.leftMouseDown.rawValue) |
        (1 << CGEventType.rightMouseDown.rawValue) |
        (1 << CGEventType.scrollWheel.rawValue) |
        (1 << CGEventType.keyDown.rawValue) |
        (1 << CGEventType.flagsChanged.rawValue)

    guard let port = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .tailAppendEventTap,
        options: .listenOnly, // never modifies or swallows the user's input
        eventsOfInterest: mask,
        callback: tapCallback,
        userInfo: nil
    ) else {
        emitLog("warn", "event tap unavailable — falling back to cursor-delta detection")
        return false
    }

    tapPort = port
    tapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, .commonModes)
    CGEvent.tapEnable(tap: port, enable: true)
    return true
}

func stopGuard() {
    if let source = tapSource {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
    }
    if let port = tapPort {
        CGEvent.tapEnable(tap: port, enable: false)
        CFMachPortInvalidate(port)
    }
    tapPort = nil
    tapSource = nil
}
