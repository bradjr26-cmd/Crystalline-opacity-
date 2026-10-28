import Foundation

// ============================================================
// GUARDIAN HEADLESS ENTRY POINT
// Full auto mode — no window, no UI, pure daemon
//
// Launched by LaunchAgent with --headless --opacity flags.
// Runs the opacity pipeline on a background task and stays alive
// via RunLoop.main.run(), which satisfies the LaunchAgent keepalive.
//
// NOTE vs original: the original imported SwiftUI and assumed an
// Xcode app target with @main GuardianApp. This executable build
// has no UI, so SwiftUI is dropped and the SwiftUI branch is gone.
// ============================================================

// Detect launch mode. If --headless is present in argv, run the daemon.
func detectLaunchMode() -> Bool {
    CommandLine.arguments.contains("--headless")
}

// MARK: - Headless Daemon Entry
func runHeadlessDaemon() {

    let useOpacity = CommandLine.arguments.contains("--opacity")

    // Value of `--name <value>`, if given.
    func flag(_ name: String) -> String? {
        guard let idx = CommandLine.arguments.firstIndex(of: name),
              idx + 1 < CommandLine.arguments.count else { return nil }
        return CommandLine.arguments[idx + 1]
    }

    let port: UInt16 = flag("--port").flatMap { UInt16($0) } ?? 8547

    // Hunter Mode's real channels. Defaults: en0 and Guardian's ~/vault.
    var signalConfig = SignalConfig()
    if let iface = flag("--iface") { signalConfig.interface = iface }
    if let vault = flag("--vault") {
        signalConfig.vaultDir = URL(fileURLWithPath: (vault as NSString).expandingTildeInPath)
    }
    if let predicate = flag("--auth-predicate") { signalConfig.authPredicate = predicate }

    print("""
    ┌─────────────────────────────────────────────────────┐
    │  GUARDIAN · OMNI CRUX OMEGA FINITE                   │
    │  Headless Daemon Mode                                │
    │  Opacity: \(useOpacity ? "ENABLED (crystalline soma)" : "DISABLED (calibrated only)")
    │  Status port: \(port)
    │  PID: \(ProcessInfo.processInfo.processIdentifier)
    └─────────────────────────────────────────────────────┘
    """)

    // Initialize engine and start the appropriate monitoring pipeline.
    let engine = GuardianEngine()

    if useOpacity {
        engine.startOpacityMonitoring()
        print("[Guardian] Crystalline opacity active. φ-basis initialized.")
        print("[Guardian] Dendritic expansion begins at cycle 0.")
    } else {
        engine.startCalibratedMonitoring()
        print("[Guardian] Calibrated monitoring active (no opacity).")
    }

    // Sample failed auths, outbound connections and vault hash drift for /signals.
    let probe = SignalProbe(config: signalConfig)
    probe.start()
    print("[Guardian] Signals: failed auths, outbound on \(signalConfig.interface), vault hash drift.")

    // Bring up the status endpoint so `curl localhost:<port>/status` works.
    let server = StatusServer(port: port, engine: engine, probe: probe)
    server.start()

    print("[Guardian] Status endpoint: http://localhost:\(port)/status")
    print("[Guardian] Signals endpoint: http://localhost:\(port)/signals")
    print("[Guardian] Entering perpetual expansion loop...")

    // Block forever — LaunchAgent keepalive requires the process to stay alive.
    RunLoop.main.run()
}

// MARK: - Log Rotation
// The LaunchAgent pipes stdout to /tmp/guardian.log.
// This trims the log to the last 10,000 lines on startup if it exceeds 50MB.
func rotateLogsIfNeeded() {
    let logPath = "/tmp/guardian.log"
    guard FileManager.default.fileExists(atPath: logPath),
          let attrs = try? FileManager.default.attributesOfItem(atPath: logPath),
          let size = attrs[.size] as? Int,
          size > 50_000_000 else { return }  // rotate if > 50MB

    print("[Guardian] Log file exceeds 50MB — rotating to last 10,000 lines.")

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/tail")
    process.arguments = ["-n", "10000", logPath]
    let pipe = Pipe()
    process.standardOutput = pipe

    try? process.run()
    process.waitUntilExit()

    let trimmed = pipe.fileHandleForReading.readDataToEndOfFile()
    try? trimmed.write(to: URL(fileURLWithPath: logPath))
    print("[Guardian] Log rotation complete.")
}
