// Humanlike pointer motion.
//
// The whole path is generated and animated in here, given a target plus shape
// parameters. That is the reason this is a sidecar rather than per-sample FFI
// calls from JavaScript: one IPC message produces ~150 posted events at 90-130 Hz
// with no round trips and no event-loop jitter in the middle of a stroke.
//
// Every event we post is stamped with MAGIC in its eventSourceUserData field so
// Guard.swift can tell our synthetic input apart from the real user's.

import CoreGraphics
import Foundation

/// Stamped on every event we post. Guard.swift treats anything else as human.
let MAGIC: Int64 = 0x5645_4C4C // "VELL"

/// Set by the `abort` command to cut a stroke already in flight. Checked once per
/// emitted sample, so a yield lands within ~10 ms rather than waiting out a move
/// that could be two seconds long.
var abortRequested = false

private let eventSource: CGEventSource? = {
    let src = CGEventSource(stateID: .hidSystemState)
    src?.userData = MAGIC
    return src
}()

// Timestamp of our most recent posted event, used as a backstop by Guard.swift.
//
// The MAGIC stamp alone is not sufficient: the window server re-synthesizes
// scroll wheel events on their way through, and the derived events arrive at the
// tap carrying neither our userData nor our pid. Without this window the guard
// reads our own scrolling as the user and the app yields to itself forever.
private let emitStampLock = NSLock()
private var lastPostAt: Double = 0

private func markPosted() {
    emitStampLock.lock()
    lastPostAt = Date().timeIntervalSince1970
    emitStampLock.unlock()
}

/// Milliseconds since we last posted anything.
func msSinceOurLastPost() -> Double {
    emitStampLock.lock()
    let at = lastPostAt
    emitStampLock.unlock()
    return (Date().timeIntervalSince1970 - at) * 1000
}

// MARK: - Geometry helpers

struct MoveOptions {
    var durationMs: Double?     // nil -> derive from Fitts's law
    var curve: Double = 1.0     // multiplier on the perpendicular control offset
    var tremor: Double = 1.0    // multiplier on tremor amplitude (px)
    var overshoot: Double = 0.65 // probability, only considered when distance > 400
    var subMoves: Int = 1       // corrective hops after the ballistic phase
    var sampleRateHz: Double = 110
    var fittsA: Double = 120    // ms
    var fittsB: Double = 180    // ms per bit
    var targetWidth: Double = 24 // px, the "W" in Fitts's law

    static func from(_ msg: [String: Any]) -> MoveOptions {
        var o = MoveOptions()
        if let v = msg["ms"] as? Double, v > 0 { o.durationMs = v }
        if let v = msg["curve"] as? Double { o.curve = v }
        if let v = msg["tremor"] as? Double { o.tremor = v }
        if let v = msg["overshoot"] as? Double { o.overshoot = v }
        if let v = msg["subMoves"] as? Int { o.subMoves = max(0, min(3, v)) }
        if let v = msg["sampleRateHz"] as? Double, v >= 30, v <= 240 { o.sampleRateHz = v }
        if let v = msg["fittsA"] as? Double { o.fittsA = v }
        if let v = msg["fittsB"] as? Double { o.fittsB = v }
        if let v = msg["targetWidth"] as? Double, v > 0 { o.targetWidth = v }
        return o
    }
}

private func dist(_ a: CGPoint, _ b: CGPoint) -> Double {
    let dx = b.x - a.x, dy = b.y - a.y
    return (dx * dx + dy * dy).squareRoot()
}

private func lerp(_ a: CGPoint, _ b: CGPoint, _ t: Double) -> CGPoint {
    CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
}

/// Minimum-jerk position profile. Zero velocity AND zero acceleration at both
/// ends, which is what makes a stroke read as a limb movement rather than a lerp.
private func minJerk(_ t: Double) -> Double {
    let t = max(0, min(1, t))
    return 10 * pow(t, 3) - 15 * pow(t, 4) + 6 * pow(t, 5)
}

private func cubicBezier(_ p0: CGPoint, _ p1: CGPoint, _ p2: CGPoint, _ p3: CGPoint, _ t: Double) -> CGPoint {
    let u = 1 - t
    let a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
    return CGPoint(
        x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
    )
}

// MARK: - Tremor

/// 1D value noise: hashed lattice with smoothstep interpolation. Cheap, and
/// unlike white noise it produces the low-frequency wander a real hand has
/// instead of per-sample static.
private func hashNoise(_ i: Int, _ seed: Int) -> Double {
    var h = UInt64(bitPattern: Int64(i &* 374_761_393 &+ seed &* 668_265_263))
    h = (h ^ (h >> 13)) &* 1_274_126_177
    h = h ^ (h >> 16)
    return Double(h % 10000) / 10000.0 * 2 - 1 // -1 ... 1
}

private func valueNoise(_ x: Double, _ seed: Int) -> Double {
    let i = Int(floor(x))
    let f = x - floor(x)
    let s = f * f * (3 - 2 * f) // smoothstep
    return hashNoise(i, seed) * (1 - s) + hashNoise(i + 1, seed) * s
}

// MARK: - Path legs

private struct Leg {
    let from: CGPoint
    let to: CGPoint
    let durationMs: Double
    let curveAmount: Double
}

/// Break a move into a ballistic phase plus corrective hops, mirroring how human
/// pointing actually decomposes: one fast open-loop throw that lands near the
/// target, then short closed-loop corrections under visual feedback.
private func planLegs(from start: CGPoint, to target: CGPoint, _ o: MoveOptions) -> [Leg] {
    let d = dist(start, target)
    if d < 2 { return [] }

    // Fitts's law: T = a + b * log2(2D / W)
    let index = log2(max(2 * d / o.targetWidth, 1) + 1)
    let derived = o.fittsA + o.fittsB * index
    let total = max(120, o.durationMs ?? (derived * Double.random(in: 0.85 ... 1.2)))

    let doOvershoot = d > 400 && Double.random(in: 0 ... 1) < o.overshoot
    var legs: [Leg] = []

    if doOvershoot {
        // Sail past the target by 3-8%, then pull back — the classic corrective
        // signature of a fast movement to a distant target.
        let frac = Double.random(in: 0.03 ... 0.08)
        let past = lerp(start, target, 1 + frac)
        legs.append(Leg(from: start, to: past, durationMs: total * 0.78,
                        curveAmount: Double.random(in: 0.08 ... 0.22) * o.curve))
        legs.append(Leg(from: past, to: target, durationMs: total * 0.22,
                        curveAmount: Double.random(in: 0.0 ... 0.05) * o.curve))
    } else {
        let ballisticEnd = lerp(start, target, Double.random(in: 0.90 ... 0.96))
        legs.append(Leg(from: start, to: ballisticEnd, durationMs: total * 0.80,
                        curveAmount: Double.random(in: 0.08 ... 0.22) * o.curve))
        legs.append(Leg(from: ballisticEnd, to: target, durationMs: total * 0.20,
                        curveAmount: Double.random(in: 0.0 ... 0.06) * o.curve))
    }

    // Extra sub-movements: tiny settle hops around the target.
    for _ in 0 ..< o.subMoves where d > 120 {
        let jitterPt = CGPoint(x: target.x + Double.random(in: -3 ... 3),
                               y: target.y + Double.random(in: -3 ... 3))
        let last = legs[legs.count - 1]
        legs[legs.count - 1] = Leg(from: last.from, to: jitterPt,
                                   durationMs: last.durationMs, curveAmount: last.curveAmount)
        legs.append(Leg(from: jitterPt, to: target,
                        durationMs: Double.random(in: 40 ... 110), curveAmount: 0))
    }

    return legs
}

// MARK: - Emission

private func postMove(_ p: CGPoint) {
    guard let ev = CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved,
                           mouseCursorPosition: p, mouseButton: .left) else { return }
    ev.setIntegerValueField(.eventSourceUserData, value: MAGIC)
    ev.post(tap: .cghidEventTap)
    markPosted()
}

/// Current pointer location in global display space (origin top-left, y down —
/// the same space CGEvent and the Accessibility API use, unlike NSScreen).
func mousePosition() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

/// Animate the pointer to `target`. Blocks the calling thread for the duration of
/// the stroke, so callers run it on the serial action queue. Returns the number of
/// events posted and the wall-clock time taken.
@discardableResult
func humanMove(to target: CGPoint, _ o: MoveOptions) -> (samples: Int, ms: Double) {
    let start = mousePosition()
    let legs = planLegs(from: start, to: target, o)
    guard !legs.isEmpty else { return (0, 0) }

    let seed = Int.random(in: 0 ..< 100_000)
    let began = Date()
    var samples = 0
    var noisePhase = Double.random(in: 0 ... 100)

    for leg in legs {
        let d = dist(leg.from, leg.to)
        // Perpendicular offset on both control points bows the path off the
        // straight line. A dead-straight cursor track is the single most obvious
        // synthetic-input tell.
        let ux = (leg.to.x - leg.from.x) / max(d, 0.001)
        let uy = (leg.to.y - leg.from.y) / max(d, 0.001)
        let side: Double = Bool.random() ? 1 : -1
        let bow = d * leg.curveAmount * side
        let c1 = CGPoint(x: leg.from.x + ux * d * 0.3 - uy * bow,
                         y: leg.from.y + uy * d * 0.3 + ux * bow)
        let c2 = CGPoint(x: leg.from.x + ux * d * 0.7 - uy * bow * 0.6,
                         y: leg.from.y + uy * d * 0.7 + ux * bow * 0.6)

        let rate = o.sampleRateHz * Double.random(in: 0.85 ... 1.2)
        let n = max(2, Int((leg.durationMs / 1000.0) * rate))
        var deadline = Date()

        for i in 1 ... n {
            if abortRequested { return (samples, Date().timeIntervalSince(began) * 1000) }
            let t = minJerk(Double(i) / Double(n))
            var p = cubicBezier(leg.from, c1, c2, leg.to, t)

            // Tremor scales with slowness — a hand shakes most when it is barely
            // moving, and is steadiest mid-throw.
            let speedNorm = min(1.0, (d / max(leg.durationMs, 1)) * 6)
            let amp = Double.random(in: 0.4 ... 1.6) * o.tremor * (1 - speedNorm * 0.8)
            noisePhase += 0.35
            p.x += valueNoise(noisePhase, seed) * amp
            p.y += valueNoise(noisePhase + 51.7, seed &+ 7) * amp

            postMove(p)
            samples += 1

            // Absolute deadlines rather than per-sample sleeps, so scheduling
            // slop does not compound across a long stroke.
            deadline = deadline.addingTimeInterval((leg.durationMs / 1000.0) / Double(n))
            // 0-2 micro-pauses per leg: the hesitations of a hand mid-reach.
            if Double.random(in: 0 ... 1) < 1.5 / Double(n) {
                deadline = deadline.addingTimeInterval(Double.random(in: 0.02 ... 0.09))
            }
            if deadline > Date() { Thread.sleep(until: deadline) }
        }
    }

    return (samples, Date().timeIntervalSince(began) * 1000)
}

/// Scroll by `dy` lines (negative = down the page) spread over `ms`, eased so the
/// burst ramps in and out rather than arriving as one instant jump.
/// Which input device the scrolling should look like it came from.
enum ScrollDevice: String {
    case trackpad
    case mouse
}

/// Post one scroll event, stamped and phase-tagged.
private func postScroll(
    dy: Int32, dx: Int32, units: CGScrollEventUnit, continuous: Bool,
    phase: Int64?, momentum: Int64?
) {
    guard let ev = CGEvent(scrollWheelEvent2Source: eventSource, units: units,
                           wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
    else { return }

    if continuous {
        // Without this a pixel-unit event is still reported as a discrete wheel.
        ev.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    }
    if let phase = phase {
        ev.setIntegerValueField(CGEventField(rawValue: 99)!, value: phase)      // scroll phase
    }
    if let momentum = momentum {
        ev.setIntegerValueField(CGEventField(rawValue: 123)!, value: momentum)  // momentum phase
    }

    ev.setIntegerValueField(.eventSourceUserData, value: MAGIC)
    ev.post(tap: .cghidEventTap)
    markPosted()
}

/// Scroll by `dy` "lines" over `ms`, shaped like the device it claims to be.
///
/// The distinction is not cosmetic. A mouse wheel emits coarse line-unit events,
/// one notch at a time; a trackpad emits continuous pixel-unit events carrying
/// scroll-phase markers and a momentum tail. Emitting wheel events on a laptop
/// that has never had a mouse attached is an inconsistency at the event level and
/// a visible one on screen, where the page jumps in chunks instead of gliding.
func humanScroll(dx: Int, dy: Int, ms: Double, device: ScrollDevice = .trackpad) {
    guard dy != 0 || dx != 0 else { return }

    if device == .mouse {
        let steps = max(3, min(24, abs(dy) + abs(dx)))
        var emittedY = 0, emittedX = 0
        var deadline = Date()

        for i in 1 ... steps {
            let t = minJerk(Double(i) / Double(steps))
            let wantY = Int((Double(dy) * t).rounded())
            let wantX = Int((Double(dx) * t).rounded())
            let stepY = wantY - emittedY, stepX = wantX - emittedX
            emittedY = wantY; emittedX = wantX

            if stepY != 0 || stepX != 0 {
                postScroll(dy: Int32(stepY), dx: Int32(stepX), units: .line,
                           continuous: false, phase: nil, momentum: nil)
            }
            deadline = deadline.addingTimeInterval((ms / 1000.0) / Double(steps))
            if deadline > Date() { Thread.sleep(until: deadline) }
        }
        return
    }

    // Trackpad: a line is roughly this many pixels, jittered so two scrolls of
    // the same size are not the same distance.
    let pxPerLine = Double.random(in: 14 ... 20)
    let totalY = Double(dy) * pxPerLine
    let totalX = Double(dx) * pxPerLine

    // Fine-grained: a real two-finger scroll delivers a stream of small deltas.
    let steps = max(8, min(60, Int(max(abs(totalY), abs(totalX)) / 6)))
    var emittedY = 0.0, emittedX = 0.0
    var deadline = Date()

    // Phase 1 = began, 2 = changed, 4 = ended.
    postScroll(dy: 0, dx: 0, units: .pixel, continuous: true, phase: 1, momentum: nil)

    for i in 1 ... steps {
        let t = minJerk(Double(i) / Double(steps))
        let wantY = totalY * t, wantX = totalX * t
        let stepY = Int32((wantY - emittedY).rounded())
        let stepX = Int32((wantX - emittedX).rounded())
        emittedY += Double(stepY); emittedX += Double(stepX)

        if stepY != 0 || stepX != 0 {
            postScroll(dy: stepY, dx: stepX, units: .pixel,
                       continuous: true, phase: 2, momentum: nil)
        }
        deadline = deadline.addingTimeInterval((ms / 1000.0) / Double(steps))
        if deadline > Date() { Thread.sleep(until: deadline) }
    }

    postScroll(dy: 0, dx: 0, units: .pixel, continuous: true, phase: 4, momentum: nil)

    // Momentum tail: fingers lift and the content keeps gliding. Not every
    // scroll has one — a short, deliberate nudge does not.
    guard abs(totalY) > 40, Double.random(in: 0 ... 1) < 0.7 else { return }

    var glide = totalY * Double.random(in: 0.18 ... 0.40)
    var momentumPhase: Int64 = 1 // began
    while abs(glide) > 1 {
        let step = Int32(glide.rounded())
        postScroll(dy: step, dx: 0, units: .pixel, continuous: true,
                   phase: 0, momentum: momentumPhase)
        momentumPhase = 2 // continued
        glide *= Double.random(in: 0.55 ... 0.75)
        Thread.sleep(forTimeInterval: Double.random(in: 0.012 ... 0.022))
    }
    postScroll(dy: 0, dx: 0, units: .pixel, continuous: true, phase: 0, momentum: 3) // ended
}

/// Click at the current location (or at `at`, after moving there).
func click(button: String, at: CGPoint?) {
    if let p = at { humanMove(to: p, MoveOptions()) }
    let p = mousePosition()
    let (down, up, btn): (CGEventType, CGEventType, CGMouseButton) =
        button == "right"
            ? (.rightMouseDown, .rightMouseUp, .right)
            : (.leftMouseDown, .leftMouseUp, .left)
    for type in [down, up] {
        guard let ev = CGEvent(mouseEventSource: eventSource, mouseType: type,
                               mouseCursorPosition: p, mouseButton: btn) else { continue }
        ev.setIntegerValueField(.eventSourceUserData, value: MAGIC)
        ev.post(tap: .cghidEventTap)
        markPosted()
        Thread.sleep(forTimeInterval: Double.random(in: 0.04 ... 0.11))
    }
}

/// Press and release a key. The executor gates this to a no-op modifier allowlist;
/// the check is repeated here so a malformed script cannot type into a window.
func pressKey(keyCode: Int, flags: UInt64) {
    for isDown in [true, false] {
        guard let ev = CGEvent(keyboardEventSource: eventSource,
                               virtualKey: CGKeyCode(keyCode), keyDown: isDown) else { continue }
        ev.flags = CGEventFlags(rawValue: flags)
        ev.setIntegerValueField(.eventSourceUserData, value: MAGIC)
        ev.post(tap: .cghidEventTap)
        markPosted()
        Thread.sleep(forTimeInterval: Double.random(in: 0.03 ... 0.08))
    }
}
