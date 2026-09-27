import Foundation
import CoreGraphics
import Darwin

// A passive, process-local lifetime monitor. It never modifies or suppresses input,
// reads key values, stores pointer positions, or asks macOS to change permissions.
// CGEvent source PID distinguishes local hardware (0) from events posted by an
// application. Flick's CGEvents carry MacHelper's PID; CDP input stays in Chrome.
// This is not a security boundary: remote desktop and input remappers may post
// software events and are not guaranteed to count as physical user activity.
// Apple: https://developer.apple.com/documentation/coregraphics/cgeventfield/eventsourceunixprocessid
// Apple: https://developer.apple.com/documentation/coregraphics/cgevent/tapcreate(tap:place:options:eventsofinterest:callback:userinfo:)

func activityKind(_ type: CGEventType, sourcePID: Int64) -> String? {
    guard sourcePID == 0 else { return nil }
    switch type {
    case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
        return "mouse"
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
        return "mouse"
    case .scrollWheel:
        return "scroll"
    case .keyDown:
        return "keyboard"
    default:
        return nil
    }
}

func emit(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    data.append(0x0a)
    FileHandle.standardOutput.write(data)
}

// Exercises classification using metadata only. No input is posted to the Mac.
func selfTest() -> Bool {
    let types: [(CGEventType, String)] = [(.mouseMoved, "mouse"), (.leftMouseDragged, "mouse"),
        (.rightMouseDragged, "mouse"), (.otherMouseDragged, "mouse"),
        (.leftMouseDown, "mouse"), (.rightMouseDown, "mouse"), (.otherMouseDown, "mouse"),
        (.scrollWheel, "scroll"), (.keyDown, "keyboard")]
    for (type, expected) in types {
        guard activityKind(type, sourcePID: 0) == expected,
              activityKind(type, sourcePID: 12345) == nil,
              activityKind(type, sourcePID: -1) == nil else { return false }
    }
    guard activityKind(.null, sourcePID: 0) == nil,
          activityKind(.leftMouseUp, sourcePID: 0) == nil,
          activityKind(.keyUp, sourcePID: 0) == nil,
          activityKind(.tapDisabledByTimeout, sourcePID: 0) == nil else { return false }
    // These mirror MacHelper's synthetic sources, without delivering any events.
    let generated = [
        CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
        CGEvent(mouseEventSource: CGEventSource(stateID: .privateState), mouseType: .leftMouseDown,
                mouseCursorPosition: .zero, mouseButton: .left),
        CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 1, wheel2: 0, wheel3: 0)
    ]
    for case let event? in generated {
        guard activityKind(event.type, sourcePID: event.getIntegerValueField(.eventSourceUnixProcessID)) == nil else { return false }
    }
    return generated.allSatisfy { $0 != nil }
}

final class ActivityMonitor {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private let runLoop = CFRunLoopGetMain()
    private var signals: [DispatchSourceSignal] = []
    private var reportedActivity = false
    private var stopped = false
    private var exitCode: Int32 = 0

    func stop(_ code: Int32 = 0) {
        guard !stopped else { return }
        stopped = true
        exitCode = code
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        CFRunLoopStop(runLoop)
    }

    func receive(_ type: CGEventType, event: CGEvent) {
        guard !stopped else { return }
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            emit(["type": "error", "code": "monitor_disabled", "message": "macOS disabled user-activity monitoring. Restart the task to restore monitoring."])
            stop(2)
            return
        }
        guard !reportedActivity, let kind = activityKind(type, sourcePID: event.getIntegerValueField(.eventSourceUnixProcessID)) else { return }
        reportedActivity = true
        emit(["type": "activity", "kind": kind, "timestamp": Int64(Date().timeIntervalSince1970 * 1000)])
    }

    func run() -> Int32 {
        if #available(macOS 10.15, *) {
            guard CGPreflightListenEventAccess() else {
                emit(["type": "error", "code": "permission_required", "message": "Allow Input Monitoring for the app running Flick in System Settings > Privacy & Security > Input Monitoring, then restart it."])
                return 2
            }
        }
        let types: [CGEventType] = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
            .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .keyDown]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        // A session tap works for the signed-in user; a HID tap requires root.
        guard let created = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
            options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, userInfo in
                if let userInfo { Unmanaged<ActivityMonitor>.fromOpaque(userInfo).takeUnretainedValue().receive(type, event: event) }
                return Unmanaged.passUnretained(event)
            }, userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
            emit(["type": "error", "code": "monitor_unavailable", "message": "macOS could not create the passive input monitor. Check Input Monitoring permission for the app running Flick, then restart it."])
            return 2
        }
        tap = created
        guard let createdSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0) else {
            emit(["type": "error", "code": "monitor_unavailable", "message": "Could not attach the input monitor to the macOS event loop."])
            CFMachPortInvalidate(created)
            return 2
        }
        source = createdSource
        CFRunLoopAddSource(runLoop, createdSource, .commonModes)
        CGEvent.tapEnable(tap: created, enable: true)
        guard CGEvent.tapIsEnabled(tap: created) else {
            emit(["type": "error", "code": "monitor_unavailable", "message": "macOS did not enable the input monitor."])
            CFMachPortInvalidate(created)
            return 2
        }

        signal(SIGPIPE, SIG_IGN)
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let signalSource = DispatchSource.makeSignalSource(signal: number, queue: .main)
            signalSource.setEventHandler { [weak self] in self?.stop() }
            signalSource.resume()
            signals.append(signalSource)
        }
        // Parent owns the lifetime: EOF ends the listener even after parent death.
        Thread.detachNewThread { [weak self] in
            while !FileHandle.standardInput.availableData.isEmpty { }
            CFRunLoopPerformBlock(CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue) { self?.stop() }
            CFRunLoopWakeUp(CFRunLoopGetMain())
        }
        emit(["type": "ready", "source": "macos-session-event-tap", "physicalInputOnly": true])
        CFRunLoopRun()
        if let source { CFRunLoopRemoveSource(runLoop, source, .commonModes) }
        CFMachPortInvalidate(created)
        for signalSource in signals { signalSource.cancel() }
        return exitCode
    }
}

if CommandLine.arguments.contains("--self-test") {
    let passed = selfTest()
    emit(["type": "self-test", "passed": passed])
    exit(passed ? 0 : 1)
}

if CommandLine.arguments.contains("--check") {
    let available: Bool
    if #available(macOS 10.15, *) { available = CGPreflightListenEventAccess() } else { available = false }
    emit(["type": "check", "available": available, "permission": available ? "granted" : "required"])
    exit(available ? 0 : 2)
}

exit(ActivityMonitor().run())
