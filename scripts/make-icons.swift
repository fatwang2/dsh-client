// Generate build/icon.png from the official DeepSeek Harness mark.
// Run: swift scripts/make-icons.swift

import AppKit

let fileManager = FileManager.default
let root = URL(fileURLWithPath: fileManager.currentDirectoryPath)

func makeDirectory(_ url: URL) throws {
    try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
}

func writePNG(_ image: NSImage, to url: URL) throws {
    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "make-icons", code: 1, userInfo: [NSLocalizedDescriptionKey: "could not render PNG for \(url.path)"])
    }
    try png.write(to: url)
}

func drawImage(size: CGFloat, scale: CGFloat, draw: (CGFloat) -> Void) -> NSImage {
    let pixel = size * scale
    let image = NSImage(size: NSSize(width: pixel, height: pixel))
    image.lockFocus()
    let ctx = NSGraphicsContext.current!.cgContext
    ctx.scaleBy(x: scale, y: scale)
    draw(size)
    image.unlockFocus()
    return image
}

// ── app icon: official DeepSeek Harness favicon ─────────────────────────────
let appIconSourceURL = root.appendingPathComponent("resources/deepseek-harness-icon.svg")
guard let appIconSource = NSImage(contentsOf: appIconSourceURL) else {
    print("error: could not load \(appIconSourceURL.path)")
    exit(1)
}

let appIcon = drawImage(size: 1024, scale: 1) { size in
    NSGraphicsContext.current?.imageInterpolation = .high
    appIconSource.draw(
        in: NSRect(x: 0, y: 0, width: size, height: size),
        from: NSRect(origin: .zero, size: appIconSource.size),
        operation: .sourceOver,
        fraction: 1
    )
}

do {
    let buildDir = root.appendingPathComponent("build")
    try makeDirectory(buildDir)
    try writePNG(appIcon, to: buildDir.appendingPathComponent("icon.png"))
    print("icon written: build/icon.png")
} catch {
    print("error: \(error.localizedDescription)")
    exit(1)
}
