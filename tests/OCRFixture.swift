import AppKit

final class PaintedView: NSView {
    var clicked = false
    override func isAccessibilityElement() -> Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill(); bounds.fill()
        NSColor.systemBlue.setFill(); NSRect(x: 45, y: 70, width: 270, height: 60).fill()
        let text = clicked ? "OCR click worked" : "Painted button"
        (text as NSString).draw(at: NSPoint(x: 60, y: 85), withAttributes: [.font: NSFont.systemFont(ofSize: 26), .foregroundColor: NSColor.white])
    }
    override func mouseDown(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        if NSRect(x: 45, y: 70, width: 270, height: 60).contains(location) {
            clicked = true; needsDisplay = true
            try? "clicked".write(toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8)
            record(event)
        }
    }
    func record(_ event: NSEvent) {
        let url = URL(fileURLWithPath: CommandLine.arguments[1] + ".events.json")
        var events = (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Int]] } ?? []
        events.append(["button": event.buttonNumber, "count": event.clickCount])
        if let data = try? JSONSerialization.data(withJSONObject: events) { try? data.write(to: url, options: .atomic) }
    }
    override func rightMouseDown(with event: NSEvent) { record(event) }
    override func otherMouseDown(with event: NSEvent) { record(event) }
}
final class Lab: NSObject, NSApplicationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 180, y: 220, width: 430, height: 240), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "OCR fixture"
        window.contentView = PaintedView(frame: NSRect(x: 0, y: 0, width: 430, height: 240))
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = Lab(); application.delegate = delegate; application.run()
