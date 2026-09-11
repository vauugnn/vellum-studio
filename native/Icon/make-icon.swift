// Renders the app icon at every size macOS wants, straight to PNG.
//
// Drawn in code rather than shipped as a binary asset: the whole set regenerates
// from one edit, there is nothing to keep in sync, and the palette is the same
// one the UI uses. CoreGraphics is already here — no image tooling to install.
//
//   swiftc -O -o dist/make-icon make-icon.swift && ./dist/make-icon <outdir>
//
// Then: iconutil -c icns <outdir>

import AppKit
import CoreGraphics
import Foundation

// Palette, matching tailwind.config.js.
let inkTop = CGColor(red: 0.15, green: 0.14, blue: 0.18, alpha: 1)     // #26242e
let inkBottom = CGColor(red: 0.063, green: 0.059, blue: 0.078, alpha: 1) // #100f14
let nibGold = CGColor(red: 0.784, green: 0.639, blue: 0.369, alpha: 1)  // #c8a35e
let nibShade = CGColor(red: 0.62, green: 0.49, blue: 0.26, alpha: 1)

/// Squircle-ish rounded rect. macOS icons use ~22.4% of the side as the radius;
/// iconutil does no masking of its own, so the shape has to be drawn here.
func roundedRect(_ rect: CGRect, radius: CGFloat) -> CGPath {
    CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
}

/// Fountain-pen nib: wide shoulders, tapering to a point, with a breather hole
/// and a slit. Built in a 0...1 box so it scales to any canvas.
func nibPath(in box: CGRect) -> CGPath {
    let p = CGMutablePath()
    let x = { (t: CGFloat) in box.minX + t * box.width }
    let y = { (t: CGFloat) in box.minY + t * box.height }

    // Outline: shoulders near the top, flanks running down to a point. The
    // flanks are nearly straight for the first third and only curve in low down
    // — a nib is a long tapered blade, and curving from the shoulders made it
    // read as a shield.
    p.move(to: CGPoint(x: x(0.02), y: y(0.14)))
    p.addCurve(to: CGPoint(x: x(0.50), y: y(1.00)),
               control1: CGPoint(x: x(0.06), y: y(0.58)),
               control2: CGPoint(x: x(0.36), y: y(0.88)))
    p.addCurve(to: CGPoint(x: x(0.98), y: y(0.14)),
               control1: CGPoint(x: x(0.64), y: y(0.88)),
               control2: CGPoint(x: x(0.94), y: y(0.58)))
    p.addCurve(to: CGPoint(x: x(0.02), y: y(0.14)),
               control1: CGPoint(x: x(0.76), y: y(-0.03)),
               control2: CGPoint(x: x(0.24), y: y(-0.03)))
    p.closeSubpath()

    // Breather hole. The radius is taken from the box height so it stays circular
    // — using the width squashed it once the nib was narrowed.
    let holeR = box.height * 0.052
    let holeCY = y(0.30)
    p.addEllipse(in: CGRect(x: x(0.5) - holeR, y: holeCY - holeR,
                            width: holeR * 2, height: holeR * 2))

    // Slit, from just below the hole down to near the tip.
    //
    // It has to START below the hole's lower edge. Overlapping them punched the
    // same region twice under even-odd filling, which turned the overlap back to
    // solid gold and left a small square wedged under the hole.
    let slitTop = holeCY + holeR * 1.25
    let slit = CGMutablePath()
    slit.move(to: CGPoint(x: x(0.5) - box.width * 0.055, y: slitTop))
    slit.addLine(to: CGPoint(x: x(0.5) + box.width * 0.055, y: slitTop))
    slit.addLine(to: CGPoint(x: x(0.5) + box.width * 0.012, y: y(0.95)))
    slit.addLine(to: CGPoint(x: x(0.5) - box.width * 0.012, y: y(0.95)))
    slit.closeSubpath()
    p.addPath(slit)

    return p
}

func drawIcon(size: Int) -> CGImage? {
    let s = CGFloat(size)
    guard let ctx = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    ctx.interpolationQuality = .high
    ctx.setShouldAntialias(true)

    // macOS leaves a margin around the art rather than bleeding to the edge.
    let inset = s * 0.06
    let plate = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let shape = roundedRect(plate, radius: plate.width * 0.224)

    // Plate, with a top-to-bottom gradient so it does not read as flat.
    ctx.saveGState()
    ctx.addPath(shape)
    ctx.clip()
    if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                                 colors: [inkTop, inkBottom] as CFArray,
                                 locations: [0, 1]) {
        ctx.drawLinearGradient(gradient,
                               start: CGPoint(x: 0, y: plate.maxY),
                               end: CGPoint(x: 0, y: plate.minY),
                               options: [])
    }
    ctx.restoreGState()

    // Hairline edge, so the plate reads as an object against a dark Dock.
    ctx.saveGState()
    ctx.addPath(shape)
    ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.07))
    ctx.setLineWidth(max(1, s * 0.004))
    ctx.strokePath()
    ctx.restoreGState()

    // The nib, upright and centred, slightly taller than wide.
    let nibW = plate.width * 0.34
    let nibH = plate.height * 0.62
    let box = CGRect(x: plate.midX - nibW / 2, y: plate.midY - nibH / 2,
                     width: nibW, height: nibH)

    // CoreGraphics has y increasing upward; the path is authored with y down, so
    // flip it about the box's centre rather than rewriting every coordinate.
    ctx.saveGState()
    ctx.translateBy(x: 0, y: box.midY * 2)
    ctx.scaleBy(x: 1, y: -1)

    let path = nibPath(in: box)

    // Soft shadow under the nib for a little depth at large sizes.
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.006), blur: s * 0.02,
                  color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.45))

    ctx.addPath(path)
    ctx.setFillColor(nibGold)
    ctx.fillPath(using: .evenOdd) // punches the breather hole and the slit

    ctx.restoreGState()

    // A darker pass along the lower flanks, hinting at a bevel.
    ctx.saveGState()
    ctx.translateBy(x: 0, y: box.midY * 2)
    ctx.scaleBy(x: 1, y: -1)
    ctx.addPath(path)
    ctx.clip(using: .evenOdd)
    if let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                          colors: [nibGold, nibShade] as CFArray, locations: [0.45, 1]) {
        ctx.drawLinearGradient(g,
                               start: CGPoint(x: 0, y: box.minY),
                               end: CGPoint(x: 0, y: box.maxY),
                               options: [])
    }
    ctx.restoreGState()

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
    guard let img = drawIcon(size: v.px) else {
        FileHandle.standardError.write("failed to render \(v.name)\n".data(using: .utf8)!)
        exit(1)
    }
    try write(img, to: outDir.appendingPathComponent("\(v.name).png"))
}

// A standalone 1024 for anywhere that wants a plain PNG (README, web).
if let img = drawIcon(size: 1024) {
    try write(img, to: outDir.deletingLastPathComponent().appendingPathComponent("icon-1024.png"))
}

print("wrote \(variants.count) sizes to \(outDir.path)")
