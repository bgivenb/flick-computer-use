import AppKit
import ApplicationServices
import CryptoKit
import Vision

enum HelperError: Error { case message(String) }
func fail(_ message: String) throws -> Never { throw HelperError.message(message) }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func string(_ element: AXUIElement, _ name: String) -> String { (attr(element, name) as? String) ?? "" }
func element(_ value: CFTypeRef?) -> AXUIElement? { value.flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil } }
func children(_ node: AXUIElement) -> [AXUIElement] { (attr(node, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func role(_ node: AXUIElement) -> String { string(node, kAXRoleAttribute) }
func parent(_ node: AXUIElement) -> AXUIElement? { element(attr(node, kAXParentAttribute)) }
func pid(of node: AXUIElement) -> pid_t { var value: pid_t = 0; AXUIElementGetPid(node, &value); return value }
// One cross-process attribute read per node, instead of a separate IPC for each field.
func attributes(_ element: AXUIElement) -> [String: CFTypeRef] {
    let keys = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                kAXPlaceholderValueAttribute, kAXHelpAttribute, kAXValueAttribute, kAXEnabledAttribute,
                kAXFocusedAttribute, kAXSelectedAttribute, kAXPositionAttribute, kAXSizeAttribute,
                kAXChildrenAttribute, kAXTitleUIElementAttribute, kAXVisibleRowsAttribute]
    var values: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(element, keys as CFArray, [], &values) == .success,
          let results = values as? [CFTypeRef] else { return [:] }
    var output: [String: CFTypeRef] = [:]
    for (key, value) in zip(keys, results) {
        if CFGetTypeID(value) == CFNullGetTypeID() { continue }
        if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { continue }
        output[key] = value
    }
    return output
}
func frame(_ values: [String: CFTypeRef]) -> CGRect? {
    guard let p = values[kAXPositionAttribute], let s = values[kAXSizeAttribute],
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var origin = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &origin), AXValueGetValue(s as! AXValue, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: origin, size: dimensions)
}
func frame(of node: AXUIElement) -> CGRect? {
    var values: [String: CFTypeRef] = [:]
    for key in [kAXPositionAttribute, kAXSizeAttribute] { if let value = attr(node, key) { values[key] = value } }
    return frame(values)
}
func accessibleName(_ values: [String: CFTypeRef]) -> String {
    var name = [kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute, kAXHelpAttribute]
        .compactMap { values[$0] as? String }.first(where: { !$0.isEmpty }) ?? ""
    if name.isEmpty, let related = element(values[kAXTitleUIElementAttribute]) { name = string(related, kAXValueAttribute) }
    return String(name.prefix(500))
}
func focusedWindow(_ root: AXUIElement) -> AXUIElement? {
    element(attr(root, kAXFocusedWindowAttribute)) ?? element(attr(root, kAXMainWindowAttribute)) ?? (attr(root, kAXWindowsAttribute) as? [AXUIElement])?.first
}

var currentApp: NSRunningApplication?
var latestRevision = ""
var latestWindow: AXUIElement?
var latestWindowFrame: CGRect?
var latestMenuFrame: CGRect?
var latestCaptureArea: CGRect?
var ocrTargets: [String: (rect: CGRect, text: String)] = [:]
var defaultOCR = "auto"
var lastRightClick: (time: Date, point: CGPoint)?
var menuSeen = false

// The same on-screen object keeps its key across observations, so a change elsewhere in the window
// neither renumbers nor invalidates it. Keys are checked against the live element before every action.
struct Entry { let node: AXUIElement; var role: String; var name: String; var seen: Int }
var entries: [String: Entry] = [:]
var keyIndex: [CFHashCode: [(node: AXUIElement, key: String)]] = [:]
var nextKey = 1
var observationCount = 0
func key(for node: AXUIElement, role: String, name: String) -> String {
    let hash = CFHash(node)
    if let known = keyIndex[hash]?.first(where: { CFEqual($0.node, node) })?.key {
        entries[known]?.role = role; entries[known]?.name = name; entries[known]?.seen = observationCount
        return known
    }
    let key = "e\(nextKey)"
    nextKey += 1
    keyIndex[hash, default: []].append((node, key))
    entries[key] = Entry(node: node, role: role, name: name, seen: observationCount)
    return key
}
func knownKey(_ node: AXUIElement) -> String? { keyIndex[CFHash(node)]?.first(where: { CFEqual($0.node, node) })?.key }
func forgetUnseen() {
    let stale = Set(entries.filter { observationCount - $0.value.seen > 30 }.map(\.key))
    guard !stale.isEmpty else { return }
    for key in stale { entries.removeValue(forKey: key) }
    for (hash, list) in keyIndex { let kept = list.filter { !stale.contains($0.key) }; keyIndex[hash] = kept.isEmpty ? nil : kept }
}

func clickPoint(_ point: CGPoint, button: String = "left", count: Int = 1) {
    let source = CGEventSource(stateID: .privateState)
    let mouseButton: CGMouseButton = button == "right" ? .right : button == "middle" ? .center : .left
    let down: CGEventType = button == "right" ? .rightMouseDown : button == "middle" ? .otherMouseDown : .leftMouseDown
    let up: CGEventType = button == "right" ? .rightMouseUp : button == "middle" ? .otherMouseUp : .leftMouseUp
    for index in 1...count {
      for type: CGEventType in [.mouseMoved, down, up] {
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: mouseButton)
        event?.flags = []
        event?.setIntegerValueField(.mouseEventButtonNumber, value: Int64(mouseButton.rawValue))
        event?.setIntegerValueField(.mouseEventClickState, value: type == .mouseMoved ? 0 : Int64(index))
        event?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.008)
      }
    }
}
// Keyboard input goes to the frontmost app, which every action verifies is the target first.
func postKey(_ code: CGKeyCode, flags: CGEventFlags = []) {
    for down in [true, false] {
        let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
        event?.flags = flags
        event?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.004)
    }
}
func typeText(_ text: String) {
    let units = Array(text.utf16)
    var index = 0
    while index < units.count {
        var end = min(index + 16, units.count)
        if end < units.count, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
        let chunk = Array(units[index..<end])
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
            chunk.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
            event?.post(tap: .cghidEventTap)
        }
        index = end
        Thread.sleep(forTimeInterval: 0.006)
    }
}

func frontmostPID() -> pid_t? {
    // NSWorkspace updates its process state on the run loop; this JSONL helper otherwise blocks in readLine.
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005))
    guard let focused = element(attr(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute)) else { return NSWorkspace.shared.frontmostApplication?.processIdentifier }
    var pid: pid_t = 0
    return AXUIElementGetPid(focused, &pid) == .success ? pid : nil
}

// Screen areas use one frame everywhere: global points with the origin at the main display's top-left,
// as Accessibility reports them. NSScreen uses a bottom-left origin, so convert before comparing.
func screen(containing point: CGPoint) -> (frame: CGRect, scale: CGFloat)? {
    guard let main = NSScreen.screens.first else { return nil }
    for screen in NSScreen.screens {
        let f = screen.frame
        let global = CGRect(x: f.minX, y: main.frame.maxY - f.maxY, width: f.width, height: f.height)
        if global.contains(point) { return (global, screen.backingScaleFactor) }
    }
    return nil
}
// Capture the screen area of the observed window rather than one Core Graphics window: apps such as Chrome
// compose one visible window from many native windows, and menus are separate windows above it. The image
// must measure exactly area × display scale, or OCR boxes cannot be mapped back to screen points.
func captureRegion(_ area: CGRect) throws -> (Data, CGRect) {
    guard CGPreflightScreenCaptureAccess() else { try fail("Screen Recording permission is required for screenshots and OCR.") }
    guard let display = screen(containing: CGPoint(x: area.midX, y: area.midY)) else { try fail("The window is not on a connected display.") }
    let rect = area.intersection(display.frame).integral
    guard rect.width >= 1, rect.height >= 1 else { try fail("No window area to capture.") }
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
    defer { try? FileManager.default.removeItem(at: path) }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-R", "\(Int(rect.minX)),\(Int(rect.minY)),\(Int(rect.width)),\(Int(rect.height))", path.path]
    process.standardError = FileHandle.nullDevice
    try process.run(); process.waitUntilExit()
    guard process.terminationStatus == 0 else { try fail("Screen capture failed.") }
    let data = try Data(contentsOf: path)
    guard let image = NSBitmapImageRep(data: data) else { try fail("Screen capture could not be read.") }
    let scaleX = CGFloat(image.pixelsWide) / rect.width, scaleY = CGFloat(image.pixelsHigh) / rect.height
    guard abs(scaleX - display.scale) < 0.05, abs(scaleY - display.scale) < 0.05 else { try fail("Screen capture size does not match the observed window; refusing to map coordinates.") }
    return (data, rect)
}
func windowArea() -> CGRect? {
    if let frame = latestWindowFrame { return latestMenuFrame.map { frame.union($0) } ?? frame }
    guard let app = currentApp, let window = focusedWindow(AXUIElementCreateApplication(app.processIdentifier)) else { return nil }
    return frame(of: window)
}

func application(_ request: [String: Any]) throws -> NSRunningApplication {
    guard let bundle = request["bundleId"] as? String else { try fail("Missing bundle ID.") }
    if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first,
       let windows = attr(AXUIElementCreateApplication(app.processIdentifier), kAXWindowsAttribute) as? [AXUIElement], !windows.isEmpty { return app }
    let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/open"); process.arguments = ["-b", bundle]
    process.standardError = FileHandle.nullDevice
    try process.run(); process.waitUntilExit()
    guard process.terminationStatus == 0 else { try fail("Could not launch target application.") }
    for _ in 0..<30 {
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first { return app }
        Thread.sleep(forTimeInterval: 0.1)
    }
    try fail("Target application did not finish launching.")
}

// An open menu is found directly instead of by walking the window: it can hang off the application,
// hold keyboard focus, sit under a menu-bar item, or appear at the point that was just right-clicked.
func openMenu(_ root: AXUIElement) -> AXUIElement? {
    guard let app = currentApp else { return nil }
    for child in children(root) where role(child) == kAXMenuRole { return child }
    var node = element(attr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute))
    for _ in 0..<6 {
        guard let current = node else { break }
        if role(current) == kAXMenuRole && pid(of: current) == app.processIdentifier { return current }
        node = parent(current)
    }
    if let bar = element(attr(root, kAXMenuBarAttribute)) {
        for item in children(bar) where (attr(item, kAXSelectedAttribute) as? NSNumber)?.boolValue == true {
            if let menu = children(item).first(where: { role($0) == kAXMenuRole }) { return menu }
        }
    }
    if let click = lastRightClick, Date().timeIntervalSince(click.time) < 20 {
        var hit: AXUIElement?
        if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(click.point.x + 12), Float(click.point.y + 12), &hit) == .success,
           let hit, role(hit) == kAXMenuItemRole, let menu = parent(hit), role(menu) == kAXMenuRole, pid(of: menu) == app.processIdentifier { return menu }
    }
    return nil
}
func awaitMenu(_ root: AXUIElement, at point: CGPoint) {
    lastRightClick = (Date(), point)
    menuSeen = false
    let deadline = Date().addingTimeInterval(0.6)
    while Date() < deadline, openMenu(root) == nil { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.015)) }
}

func observe(_ ocrMode: String = "auto") throws -> [String: Any] {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005))
    guard AXIsProcessTrusted() else { try fail("Accessibility permission is required for the native helper. Enable the launching application in System Settings > Privacy & Security > Accessibility.") }
    guard let app = currentApp, !app.isTerminated else { try fail("Target application is not running.") }
    observationCount += 1
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 1.0)
    let window = focusedWindow(root) ?? root
    latestWindow = window
    var result: [[String: Any]] = []
    var texts: [String] = []
    var visited = 0
    var truncated = false
    var windowFrame = frame(of: window)
    // Chrome reports the content rectangle as its window frame; toolbar siblings extend above it.
    for child in children(window) {
        if let childFrame = frame(of: child), childFrame.width > 0, childFrame.height > 0 { windowFrame = windowFrame.map { $0.union(childFrame) } ?? childFrame }
    }
    latestWindowFrame = windowFrame
    let menu = openMenu(root)
    latestMenuFrame = menu.flatMap { frame(of: $0) }
    // Once a right-click's menu has been seen and closed, the pointer location no longer implies a menu.
    if menu != nil { menuSeen = true } else if menuSeen { lastRightClick = nil; menuSeen = false }
    var deferWebContent = true, markModal = false
    var deferred: [(AXUIElement, Int, String)] = []
    let fieldRoles = [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole, kAXPopUpButtonRole]
    // Returns the node's role and, for static text, its text, so a following unlabeled field can use it as a label.
    @discardableResult
    func visit(_ node: AXUIElement, _ depth: Int, _ inMenu: Bool, _ context: String, _ budget: Int, _ hint: String) -> (String, String) {
        if depth > 60 || visited >= budget { truncated = true; return ("", "") }
        visited += 1
        let values = attributes(node)
        let role = values[kAXRoleAttribute] as? String ?? ""
        // Browser toolbars and tabs are read first; page content gets the remaining budget.
        if role == "AXWebArea" && deferWebContent { deferred.append((node, depth, context)); return (role, "") }
        let rect = frame(values)
        // A container drawn entirely outside the window cannot hold visible controls.
        if let rect, !rect.isEmpty, !inMenu, let windowFrame, !windowFrame.intersects(rect) { return (role, "") }
        let subrole = values[kAXSubroleAttribute] as? String ?? ""
        let name = accessibleName(values)
        let label = name.isEmpty && fieldRoles.contains(role) ? hint : name
        let display = label.isEmpty ? role : label
        let secret = subrole == kAXSecureTextFieldSubrole
        let raw = values[kAXValueAttribute]
        let value = secret ? "[redacted]" : (raw as? String ?? (raw as? NSNumber)?.stringValue ?? "")
        let visible = rect.map { !$0.isEmpty && (inMenu || (windowFrame?.intersects($0) ?? true)) } ?? false
        if visible && role == kAXStaticTextRole && !secret { texts.append(String((value.isEmpty ? display : value).prefix(1000))) }
        var available: CFArray?
        AXUIElementCopyActionNames(node, &available)
        let supported = (available as? [String]) ?? []
        var actions: [String] = []
        let pointerRoles = [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole, kAXRowRole, kAXCellRole, kAXPopUpButtonRole, kAXMenuButtonRole, kAXImageRole]
        let anonymousContainer = role == kAXGroupRole && label.isEmpty
        if !secret && !anonymousContainer && (supported.contains(kAXPressAction) || (pointerRoles.contains(role) && rect != nil)) { actions.append("click") }
        // A field whose value cannot be set directly can still be typed into once it takes focus.
        var settable: DarwinBoolean = false, focusable: DarwinBoolean = false
        let textRole = [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role)
        if textRole { AXUIElementIsAttributeSettable(node, kAXValueAttribute as CFString, &settable) }
        if textRole && !settable.boolValue { AXUIElementIsAttributeSettable(node, kAXFocusedAttribute as CFString, &focusable) }
        if !secret && textRole && (settable.boolValue || focusable.boolValue) { actions.append("fill") }
        if visible && (!actions.isEmpty || secret || (role == kAXStaticTextRole && !value.isEmpty)) {
            if result.count < 600 {
                let roleMap = [kAXButtonRole: "button", kAXTextFieldRole: "textbox", kAXTextAreaRole: "textbox", kAXCheckBoxRole: "checkbox", kAXRadioButtonRole: "radio", kAXComboBoxRole: "combobox"]
                var item: [String: Any] = ["id": key(for: node, role: role, name: name), "role": roleMap[role] ?? role, "name": display, "disabled": !((values[kAXEnabledAttribute] as? NSNumber)?.boolValue ?? true), "actions": actions, "source": "accessibility",
                    "focused": (values[kAXFocusedAttribute] as? NSNumber)?.boolValue ?? false,
                    "selected": (values[kAXSelectedAttribute] as? NSNumber)?.boolValue ?? false]
                if !context.isEmpty { item["context"] = context }
                if let rect { item["bounds"] = ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height] }
                if role == kAXTextAreaRole { item["multiline"] = true }
                if markModal { item["modal"] = true }
                // A context menu is worth offering on images, links, fields, and list items, not on every control.
                var variants: [String] = []
                if role == kAXImageRole || (["AXLink", kAXTextFieldRole, kAXTextAreaRole, kAXCellRole, kAXRowRole].contains(role) && supported.contains(kAXShowMenuAction)) { variants.append("right") }
                if role == kAXCellRole || role == kAXRowRole || role == kAXStaticTextRole { variants.append("double") }
                if !variants.isEmpty { item["clickVariants"] = variants }
                if !value.isEmpty || actions.contains("fill") { item["value"] = String(value.prefix(10000)) }
                if [kAXCheckBoxRole, kAXRadioButtonRole].contains(role) { item["checked"] = (raw as? NSNumber)?.boolValue ?? false }
                result.append(item)
            } else { truncated = true }
        }
        // Web elements can return an empty AXVisibleRows even when they have children.
        let rows = [kAXTableRole, kAXOutlineRole].contains(role) ? values[kAXVisibleRowsAttribute] as? [AXUIElement] : nil
        if let nodes = rows ?? (values[kAXChildrenAttribute] as? [AXUIElement]) {
            let nextContext = !label.isEmpty && !actions.contains("fill") ? label : context
            var lastText = ""
            for child in nodes {
                let (childRole, childText) = visit(child, depth + 1, inMenu || role == kAXMenuRole, nextContext, budget, lastText)
                if childRole == kAXStaticTextRole && !childText.isEmpty { lastText = childText } else if fieldRoles.contains(childRole) { lastText = "" }
            }
        }
        return (role, role == kAXStaticTextRole ? (value.isEmpty ? name : value) : "")
    }
    if let menu {
        // While a menu is open, it is the interface: its items are the only meaningful targets.
        markModal = true
        visit(menu, 0, true, "", 600, "")
        markModal = false
    } else {
        visit(window, 0, false, "", 2000, "")
        deferWebContent = false
        let pageBudget = visited + 2000
        for (web, depth, context) in deferred { visit(web, depth, false, context, pageBudget, "") }
        let pageTruncated = truncated
        if let menuBar = element(attr(root, kAXMenuBarAttribute)) { visit(menuBar, 0, true, "", visited + 80, "") }
        truncated = pageTruncated
    }
    let readable = texts.joined() + result.compactMap { $0["value"] as? String }.joined()
    var ocr: [String: Any] = ["used": false]
    ocrTargets = [:]
    latestCaptureArea = nil
    let recentRightClick = lastRightClick.map { Date().timeIntervalSince($0.time) < 5 } ?? false
    let shouldRunOCR = ocrMode == "always" || (ocrMode == "auto" && menu == nil && (readable.count < 40 || recentRightClick))
    if shouldRunOCR, var area = windowFrame {
        if !CGPreflightScreenCaptureAccess() && ocrMode == "auto" {
            ocr["reason"] = "Screen Recording permission is unavailable."
        } else {
            let started = Date()
            // A context menu that Accessibility cannot see opens at the pointer and may extend past the window.
            if menu == nil, recentRightClick, let click = lastRightClick { area = area.union(CGRect(x: click.point.x - 20, y: click.point.y - 20, width: 520, height: 820)) }
            let (data, bounds) = try captureRegion(area)
            latestCaptureArea = bounds
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            try VNImageRequestHandler(data: data).perform([request])
            let lines = (request.results ?? []).sorted { a, b in a.boundingBox.midY == b.boundingBox.midY ? a.boundingBox.minX < b.boundingBox.minX : a.boundingBox.midY > b.boundingBox.midY }
            for (index, line) in lines.prefix(120).enumerated() {
                guard let candidate = line.topCandidates(1).first else { continue }
                let box = line.boundingBox
                let rect = CGRect(x: bounds.minX + box.minX * bounds.width, y: bounds.minY + (1 - box.maxY) * bounds.height, width: box.width * bounds.width, height: box.height * bounds.height)
                let id = "ocr." + String(index)
                texts.append(candidate.string)
                // Accessible controls already have precise targets; OCR contributes any remaining text regions.
                if result.contains(where: { ($0["name"] as? String) == candidate.string }) { continue }
                ocrTargets[id] = (rect, candidate.string)
                result.append(["id": id, "role": "text", "name": candidate.string, "disabled": false, "actions": ["click"], "source": "ocr", "confidence": candidate.confidence,
                               "bounds": ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]])
            }
            ocr = ["used": true, "durationMs": Int(Date().timeIntervalSince(started) * 1000)]
        }
    }
    let title = string(window, kAXTitleAttribute)
    let text = String(texts.joined(separator: "\n").prefix(24000))
    let geometry = windowFrame.map { [$0.minX, $0.minY, $0.width, $0.height] } ?? []
    let stable: [String: Any] = ["pid": app.processIdentifier, "title": title, "text": text, "elements": result, "geometry": geometry]
    let data = try JSONSerialization.data(withJSONObject: stable, options: [.sortedKeys])
    latestRevision = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    forgetUnseen()
    let clipboard = NSPasteboard.general
    let imageTypes: [NSPasteboard.PasteboardType] = [.png, .tiff]
    var output: [String: Any] = ["title": title, "text": text, "elements": result, "revision": latestRevision, "truncated": truncated, "ocr": ocr,
            "clipboard": ["changeCount": clipboard.changeCount, "hasImage": imageTypes.contains { clipboard.types?.contains($0) == true }]]
    if let focused = element(attr(root, kAXFocusedUIElementAttribute)), let focusedKey = knownKey(focused) { output["focusedId"] = focusedKey }
    if let menu { output["modal"] = ["kind": "menu", "label": string(menu, kAXTitleAttribute)] }
    return output
}

func similar(_ a: String, _ b: String) -> Bool {
    let clean = { (text: String) in text.lowercased().filter { $0.isLetter || $0.isNumber } }
    let x = clean(a), y = clean(b)
    return !x.isEmpty && !y.isEmpty && (x.contains(y) || y.contains(x))
}
// Before any pointer event, confirm what is actually under the point: the target itself (or, for OCR text,
// an unlabeled area or a control whose label matches the text), in the target app, inside the observed window
// or menu, and never a window's close, minimize, zoom, or full-screen button. Returns a pressable control for OCR text.
func clearedTarget(at point: CGPoint, expecting target: AXUIElement?, text: String?) throws -> AXUIElement? {
    if let window = latestWindowFrame, !window.contains(point), latestMenuFrame?.contains(point) != true, !(text != nil && latestCaptureArea?.contains(point) == true) { try fail("The click point is outside the observed window; refusing to click.") }
    var found: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &found) == .success, let hit = found else { try fail("Nothing accessible is under the click point; refusing to click.") }
    guard pid(of: hit) == currentApp?.processIdentifier else { try fail("Another application is under the click point; refusing to click.") }
    let windowControls = [kAXCloseButtonSubrole, kAXMinimizeButtonSubrole, kAXZoomButtonSubrole, kAXFullScreenButtonSubrole]
    var node: AXUIElement? = hit, depth = 0, pressable: AXUIElement?, label: String?
    while let current = node, depth < 30 {
        if let target, CFEqual(current, target) { return target }
        let values = attributes(current)
        if windowControls.contains(values[kAXSubroleAttribute] as? String ?? "") { try fail("A window control is under the click point; refusing to click.") }
        if target == nil && depth < 4 {
            let name = accessibleName(values)
            if label == nil, !name.isEmpty { label = name }
            var actions: CFArray?
            AXUIElementCopyActionNames(current, &actions)
            if pressable == nil, ((actions as? [String]) ?? []).contains(kAXPressAction) { pressable = current }
        }
        node = parent(current); depth += 1
    }
    if let target {
        // The hit may be a container when the target itself is not hit-testable.
        var up: AXUIElement? = target, steps = 0
        while let current = up, steps < 30 { if CFEqual(current, hit) { return target }; up = parent(current); steps += 1 }
        try fail("STALE_OBSERVATION")
    }
    if let text, let label, !similar(label, text) { try fail("The text under the click point no longer matches what was read; refusing to click.") }
    return label == nil ? nil : pressable
}
func isSame(_ node: AXUIElement, orInside container: AXUIElement) -> Bool {
    var current: AXUIElement? = node, steps = 0
    while let item = current, steps < 12 { if CFEqual(item, container) { return true }; current = parent(item); steps += 1 }
    return false
}
func focus(_ node: AXUIElement) -> Bool {
    AXUIElementSetAttributeValue(node, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    Thread.sleep(forTimeInterval: 0.04)
    guard let app = currentApp, let focused = element(attr(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedUIElementAttribute)) else { return false }
    return isSame(focused, orInside: node)
}
// Leaves keyboard focus in the field, as typing would, so a following Enter reaches it.
func fill(_ node: AXUIElement, _ value: String) throws {
    var settable: DarwinBoolean = false
    AXUIElementIsAttributeSettable(node, kAXValueAttribute as CFString, &settable)
    if settable.boolValue, AXUIElementSetAttributeValue(node, kAXValueAttribute as CFString, value as CFString) == .success, string(node, kAXValueAttribute) == value { _ = focus(node); return }
    // Rich editors can accept an Accessibility value without updating their own state; type into them instead.
    // A newline could submit a form or send a message, so multi-line text is never typed.
    guard !value.contains(where: \.isNewline) else { try fail("Multi-line text could not be set directly and is not typed, because a newline could submit. Paste it instead.") }
    guard focus(node) else { try fail("Could not focus the field to type into it.") }
    postKey(0, flags: .maskCommand)
    typeText(value)
    Thread.sleep(forTimeInterval: 0.05)
}

func action(_ request: [String: Any]) throws -> [String: Any] {
    guard let app = currentApp, frontmostPID() == app.processIdentifier else { try fail("Focus moved to another application. Inspect and refocus before acting.") }
    guard let data = request["action"] as? [String: Any], let kind = data["kind"] as? String else { try fail("Missing action.") }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    // The observed window must still be in front; unrelated changes inside it do not invalidate a target.
    if let observed = latestWindow, let now = focusedWindow(root), !CFEqual(observed, now) { try fail("STALE_OBSERVATION") }
    let button = data["button"] as? String ?? "left"
    let clickCount = data["clickCount"] as? Int ?? 1
    let elementId = data["elementId"] as? String ?? ""
    if kind == "click", elementId.hasPrefix("ocr.") {
        // OCR text has no identity of its own: it is valid only for the observation it came from.
        guard request["revision"] as? String == latestRevision, let target = ocrTargets[elementId] else { try fail("STALE_OBSERVATION") }
        let point = CGPoint(x: target.rect.midX, y: target.rect.midY)
        let pressable = try clearedTarget(at: point, expecting: nil, text: target.text)
        if button == "left", clickCount == 1, let pressable, AXUIElementPerformAction(pressable, kAXPressAction as CFString) == .success { return ["ok": true, "source": "ocr", "pressed": true] }
        clickPoint(point, button: button, count: clickCount)
        if button == "right" { awaitMenu(root, at: point) }
        return ["ok": true, "source": "ocr"]
    }
    if kind == "click" || kind == "fill" {
        guard let entry = entries[elementId], entry.seen == observationCount else { try fail("STALE_OBSERVATION") }
        let values = attributes(entry.node)
        guard values[kAXRoleAttribute] as? String == entry.role, accessibleName(values) == entry.name else { try fail("STALE_OBSERVATION") }
        if (values[kAXEnabledAttribute] as? NSNumber)?.boolValue == false { try fail("The control is disabled.") }
        if values[kAXSubroleAttribute] as? String == kAXSecureTextFieldSubrole { try fail("Secure fields must be handled manually.") }
        if kind == "click" {
            if button == "left" && clickCount == 1 && AXUIElementPerformAction(entry.node, kAXPressAction as CFString) == .success { return ["ok": true] }
            guard let rect = frame(values), !rect.isEmpty else { try fail("Accessibility press failed and no control bounds are available.") }
            let point = CGPoint(x: rect.midX, y: rect.midY)
            _ = try clearedTarget(at: point, expecting: entry.node, text: nil)
            clickPoint(point, button: button, count: clickCount)
            if button == "right" { awaitMenu(root, at: point) }
        } else {
            guard let value = data["value"] as? String else { try fail("Missing fill value.") }
            try fill(entry.node, value)
            if data["submit"] as? Bool == true {
                guard focus(entry.node) else { try fail("The value was entered, but the field could not take focus to submit it.") }
                postKey(36)
            }
        }
    } else if kind == "press" {
        // A key goes wherever focus is, so focus must still be where it was observed.
        if let expected = request["focusedId"] as? String, let entry = entries[expected], let now = element(attr(root, kAXFocusedUIElementAttribute)), !CFEqual(now, entry.node) { try fail("STALE_OBSERVATION") }
        let keys: [String: CGKeyCode] = ["Enter": 36, "Tab": 48, "Escape": 53, "ArrowDown": 125, "ArrowUp": 126, "ArrowLeft": 123, "ArrowRight": 124, "Backspace": 51, "a": 0, "c": 8, "n": 45, "o": 31, "v": 9, "f": 3, "s": 1, "w": 13]
        guard let key = data["key"] as? String, let code = keys[key] else { try fail("Unsupported key.") }
        var flags: CGEventFlags = []
        for modifier in data["modifiers"] as? [String] ?? [] {
            if modifier == "Meta" { flags.insert(.maskCommand) }; if modifier == "Shift" { flags.insert(.maskShift) }
            if modifier == "Alt" { flags.insert(.maskAlternate) }; if modifier == "Control" { flags.insert(.maskControl) }
        }
        postKey(code, flags: flags)
    } else if kind == "scroll" {
        let direction: Int32 = data["direction"] as? String == "up" ? 400 : -400
        let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: direction, wheel2: 0, wheel3: 0)
        if let window = latestWindowFrame { event?.location = CGPoint(x: window.midX, y: window.midY) }
        event?.postToPid(app.processIdentifier)
    } else { try fail("Unsupported native action.") }
    return ["ok": true]
}

func handle(_ request: [String: Any]) throws -> [String: Any] {
    switch request["method"] as? String {
    case "health": return ["accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess()]
    case "copy_image":
        guard let encoded = request["png"] as? String, let data = Data(base64Encoded: encoded), data.count <= 20_000_000, NSImage(data: data) != nil else { try fail("Invalid clipboard image.") }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        guard pasteboard.setData(data, forType: .png), pasteboard.data(forType: .png) == data else { try fail("Clipboard image could not be verified.") }
        return ["copied": true, "bytes": data.count]
    case "apps":
        return ["apps": NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map { ["name": $0.localizedName ?? "", "bundleId": $0.bundleIdentifier ?? "", "pid": $0.processIdentifier] as [String: Any] }]
    case "catalog":
        var apps: [String: [String: Any]] = [:]
        for directory in ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"] {
            guard let enumerator = FileManager.default.enumerator(at: URL(fileURLWithPath: directory), includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { continue }
            while let url = enumerator.nextObject() as? URL {
                if url.pathExtension != "app" { continue }
                enumerator.skipDescendants()
                guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier else { continue }
                let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? url.deletingPathExtension().lastPathComponent
                apps[id] = ["bundleId": id, "name": name, "running": false]
            }
        }
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
            if let id = app.bundleIdentifier { apps[id] = ["bundleId": id, "name": app.localizedName ?? id, "running": true] }
        }
        return ["apps": apps.values.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }]
    case "connect":
        guard AXIsProcessTrusted() else { try fail("Accessibility permission is required. Run doctor for setup instructions.") }
        currentApp = try application(request)
        defaultOCR = request["ocr"] as? String ?? "auto"
        entries = [:]; keyIndex = [:]; latestWindow = nil; latestWindowFrame = nil; latestMenuFrame = nil; lastRightClick = nil
        // Chromium/Electron publish their full tree only after an accessibility client opts in.
        AXUIElementSetAttributeValue(AXUIElementCreateApplication(currentApp!.processIdentifier), "AXManualAccessibility" as CFString, kCFBooleanTrue)
        guard currentApp!.activate(options: []) else { try fail("Could not activate target application.") }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.12))
        return ["connected": true]
    case "observe": return try observe(request["ocr"] as? String ?? defaultOCR)
    case "act": return try action(request)
    case "screenshot":
        guard let area = windowArea() else { try fail("No capturable window.") }
        return ["png": try captureRegion(area).0.base64EncodedString()]
    default: try fail("Unknown helper method.")
    }
}

while let line = readLine() {
    var output: [String: Any] = [:]
    do {
        guard let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try fail("Invalid JSON request.") }
        output["id"] = request["id"]
        output["result"] = try handle(request)
    } catch HelperError.message(let message) { output["error"] = message }
      catch { output["error"] = "Native helper operation failed." }
    if let data = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) {
        print(text)
        fflush(stdout)
    }
}
