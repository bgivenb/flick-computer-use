import AppKit

final class Lab: NSObject, NSApplicationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 150, y: 200, width: 620, height: 400), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let email = NSTextField(frame: NSRect(x: 30, y: 230, width: 540, height: 32))
    let checkbox = NSButton(checkboxWithTitle: "Include column headers", target: nil, action: nil)
    let status = NSTextField(labelWithString: "Changes have not been saved.")
    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Jev native automation lab"
        let heading = NSTextField(labelWithString: "Disposable native test")
        heading.font = .boldSystemFont(ofSize: 26); heading.frame = NSRect(x: 30, y: 330, width: 550, height: 40)
        let label = NSTextField(labelWithString: "Contact email")
        label.frame = NSRect(x: 30, y: 272, width: 300, height: 24)
        email.setAccessibilityLabel("Contact email")
        email.placeholderString = "demo@example.com"
        checkbox.frame = NSRect(x: 30, y: 165, width: 450, height: 32)
        let save = NSButton(title: "Save settings", target: self, action: #selector(saveSettings))
        save.frame = NSRect(x: 30, y: 105, width: 180, height: 40); save.bezelStyle = .rounded
        status.frame = NSRect(x: 30, y: 45, width: 550, height: 30)
        for view in [heading, label, email, checkbox, save, status] as [NSView] { window.contentView!.addSubview(view) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func saveSettings() {
        let state: [String: Any] = ["email": email.stringValue, "headers": checkbox.state == .on]
        guard let data = try? JSONSerialization.data(withJSONObject: state), CommandLine.arguments.count > 1 else { return }
        do { try data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic); status.stringValue = "Native settings saved" }
        catch { status.stringValue = "Save failed" }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = Lab()
application.delegate = delegate
application.run()
