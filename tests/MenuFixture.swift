import AppKit

// A photo with a native context menu, plus a small borderless child window over the title bar. Chrome draws
// its window controls and toolbars as such child windows; capture code that picks "the first window of the
// app" chooses one of them and maps OCR text into the wrong rectangle.
final class PhotoView: NSView {
    let output: String
    init(frame: NSRect, output: String) { self.output = output; super.init(frame: frame) }
    required init?(coder: NSCoder) { fatalError() }
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .image }
    override func accessibilityLabel() -> String? { "Sample photograph" }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemTeal.setFill(); bounds.fill()
        ("Painted caption" as NSString).draw(at: NSPoint(x: 20, y: 20), withAttributes: [.font: NSFont.boldSystemFont(ofSize: 22), .foregroundColor: NSColor.white])
    }
    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        for (title, action) in [("Open Photo", #selector(open)), ("Copy Image", #selector(copyImage)), ("Save Image As…", #selector(open))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: ""); item.target = self; menu.addItem(item)
        }
        return menu
    }
    @objc func open() { try? "opened".write(toFile: output, atomically: true, encoding: .utf8) }
    @objc func copyImage() {
        guard let rep = bitmapImageRepForCachingDisplay(in: bounds) else { return }
        cacheDisplay(in: bounds, to: rep)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setData(rep.representation(using: .png, properties: [:]), forType: .png)
        try? "copied".write(toFile: output, atomically: true, encoding: .utf8)
    }
}
final class Lab: NSObject, NSApplicationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 160, y: 200, width: 520, height: 360), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    let badge = NSWindow(contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: false)
    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Menu fixture"
        window.contentView = PhotoView(frame: NSRect(x: 0, y: 0, width: 520, height: 360), output: CommandLine.arguments[1])
        window.makeKeyAndOrderFront(nil)
        let top = window.frame
        badge.setFrame(NSRect(x: top.minX + 10, y: top.maxY - 26, width: 66, height: 20), display: true)
        badge.backgroundColor = .systemRed
        window.addChildWindow(badge, ordered: .above)
        NSApp.activate(ignoringOtherApps: true)
    }
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = Lab(); application.delegate = delegate; application.run()
