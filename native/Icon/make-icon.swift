// Renders the app icon at every size macOS wants, straight to PNG.
//
// Drawn in code rather than shipped as a binary asset: the whole set regenerates
// from one edit, there is nothing to keep in sync, and the geometry is the same
// one the interface draws. CoreGraphics is already here — no image tooling to
// install.
//
//   swiftc -O -o dist/make-icon make-icon.swift && ./dist/make-icon <outdir>
//
// Then: iconutil -c icns <outdir>
//
// The mark: three ink circles of radius 16 on a 64 grid, centred at 24,25 —
// 40,25 — 32,38.9, every overlap a flat fill. Painted, not composited — a
// blend mode would invert on the wrong ground. No plate, no gradient, no
// shadow: the pigment sits directly on whatever is behind it.

import AppKit
import CoreGraphics
import Foundation

func rgb(_ hex: UInt32) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255,
            alpha: 1)
}

let vermilion = rgb(0xD8452C)
let amber = rgb(0xE8B31F)
let ultramarine = rgb(0x4459E0)
let vermilionAmber = rgb(0xE5711F)
let vermilionBlue = rgb(0x8B3FD4)
let amberBlue = rgb(0x3E9E5C)
let centre = rgb(0x33305E)

/// The three circles on the 64 grid. The brief's coordinates run y-down; the
/// context is flipped once so these can be used as written.
let grid: CGFloat = 64
let radius: CGFloat = 16
let a = CGPoint(x: 24, y: 25)
let b = CGPoint(x: 40, y: 25)
let c = CGPoint(x: 32, y: 38.9)

func circle(_ p: CGPoint) -> CGPath {
    CGPath(ellipseIn: CGRect(x: p.x - radius, y: p.y - radius,
                             width: radius * 2, height: radius * 2), transform: nil)
}

func fill(_ ctx: CGContext, _ path: CGPath, _ color: CGColor, clippedTo clips: [CGPath] = []) {
    ctx.saveGState()
    for clip in clips {
        ctx.addPath(clip)
        ctx.clip()
    }
    ctx.addPath(path)
    ctx.setFillColor(color)
    ctx.fillPath()
    ctx.restoreGState()
}

func drawMark(size: Int) -> CGImage? {
    let s = CGFloat(size)
    guard let ctx = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    ctx.interpolationQuality = .high
    ctx.setShouldAntialias(true)

    // Scale the 64 grid to the canvas and flip to y-down.
    ctx.translateBy(x: 0, y: s)
    ctx.scaleBy(x: s / grid, y: -s / grid)

    let A = circle(a), B = circle(b), C = circle(c)

    // Bases first, then each overlap painted over the top in the fixed order
    // the geometry needs: pairs, then the centre where all three meet.
    fill(ctx, A, vermilion)
    fill(ctx, B, amber)
    fill(ctx, C, ultramarine)
    fill(ctx, B, vermilionAmber, clippedTo: [A])
    fill(ctx, C, vermilionBlue, clippedTo: [A])
    fill(ctx, C, amberBlue, clippedTo: [B])
    fill(ctx, C, centre, clippedTo: [A, B])

    return ctx.makeImage()
}

func write(_ image: CGImage, to url: URL) throws {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "icon", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "PNG encoding failed"])
    }
    try data.write(to: url)
}

// ── main ────────────────────────────────────────────────────────────────────

let outDir = CommandLine.arguments.count > 1
    ? URL(fileURLWithPath: CommandLine.arguments[1])
    : URL(fileURLWithPath: "icon.iconset")
let parent = outDir.deletingLastPathComponent()

try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

// The exact set iconutil expects. Missing any one of these makes it refuse.
let variants: [(name: String, px: Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]

for v in variants {
    guard let img = drawMark(size: v.px) else {
        FileHandle.standardError.write("failed to render \(v.name)\n".data(using: .utf8)!)
        exit(1)
    }
    try write(img, to: outDir.appendingPathComponent("\(v.name).png"))
}

// A standalone 1024 for anywhere that wants a plain PNG (README, web).
if let img = drawMark(size: 1024) {
    try write(img, to: parent.appendingPathComponent("icon-1024.png"))
}

// The menu-bar item, at 1x and 2x. 16pt is the smallest the mark is drawn at.
if let img = drawMark(size: 16) {
    try write(img, to: parent.appendingPathComponent("tray-16.png"))
}
if let img = drawMark(size: 32) {
    try write(img, to: parent.appendingPathComponent("tray-16@2x.png"))
}

print("wrote \(variants.count) sizes to \(outDir.path)")
