import AppKit

final class TransferLab: NSObject, NSApplicationDelegate {
    let sender = CommandLine.arguments[1] == "source"
    let payload = CommandLine.arguments[2]
    let output = CommandLine.arguments[3]
    let window = NSWindow(contentRect: NSRect(x: 200, y: 250, width: 660, height: 330), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let field = NSTextField(frame: NSRect(x: 30, y: 170, width: 590, height: 34))
    let status = NSTextField(labelWithString: "No transfer has been saved.")
    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = sender ? "Source Notes" : "Dispatch Desk"
        let heading = NSTextField(labelWithString: sender ? "Reference supplied by another app" : "Receive and save a reference")
        heading.font = .boldSystemFont(ofSize: 24); heading.frame = NSRect(x: 30, y: 255, width: 600, height: 40)
        let label = NSTextField(labelWithString: "Task reference")
        label.frame = NSRect(x: 30, y: 210, width: 300, height: 24)
        field.setAccessibilityLabel("Task reference")
        field.isEditable = !sender; field.isSelectable = true
        field.stringValue = sender ? payload : ""
        status.stringValue = sender ? "This reference is ready to copy." : "No transfer has been saved."
        status.frame = NSRect(x: 30, y: 35, width: 590, height: 30)
        for view in [heading, label, field, status] { window.contentView!.addSubview(view) }
        if !sender {
            let save = NSButton(title: "Save transfer", target: self, action: #selector(saveTransfer))
            save.frame = NSRect(x: 30, y: 95, width: 170, height: 40); save.bezelStyle = .rounded
            window.contentView!.addSubview(save)
        }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    @objc func saveTransfer() {
        do { try field.stringValue.write(toFile: output, atomically: true, encoding: .utf8); status.stringValue = "Transfer saved" }
        catch { status.stringValue = "Save failed" }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = TransferLab()
application.delegate = delegate
application.run()
