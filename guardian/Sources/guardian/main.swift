import Foundation

// ============================================================
// GUARDIAN ENTRY POINT  (main.swift)
//
// This replaces the Xcode @main / SwiftUI dispatch with a plain
// executable entry. The original GuardianHeadless.swift was written
// for an Xcode app target and imported SwiftUI; a headless daemon
// launched by a LaunchAgent never draws UI, so this executable
// drops SwiftUI entirely and just runs the daemon.
//
//   --headless   run as daemon (required for LaunchAgent)
//   --opacity    enable crystalline-soma pipeline (φ-basis)
//   --port N     status HTTP port (default 8547)
//   --iface IF   interface whose outbound connections /signals counts (default en0)
//   --vault DIR  evidence vault whose ledger /signals re-hashes (default ~/vault)
//   --auth-predicate P   unified-log predicate for failed auths (see SignalProbe)
//   --icloud-dir DIR     where the phone's hunter_signals.json goes
//                        (default iCloud Drive/guardian_opacity)
//   --no-icloud          don't write the phone's snapshot
// ============================================================

// The LaunchAgent sends stdout to /tmp/guardian.log. A file is block-buffered by
// default, so lines would sit unwritten (and be lost when launchd restarts the
// process). Line-buffer it so every message lands as it's printed.
setvbuf(stdout, nil, _IOLBF, 0)

rotateLogsIfNeeded()

if detectLaunchMode() {
    runHeadlessDaemon()
} else {
    // No UI in this build. Print usage and exit cleanly.
    print("""
    Guardian (headless build)
    Usage: guardian --headless [--opacity] [--port <n>] [--iface <if>] [--vault <dir>]

      --headless   Run as a perpetual daemon (LaunchAgent keepalive).
      --opacity    Enable crystalline-soma monitoring (φ-basis).
                   Omit for calibrated-only monitoring.
      --port <n>   Status endpoint port (default 8547).
      --iface <if> Interface for the outbound-connections signal (default en0).
      --vault <dir> Evidence vault for the hash-drift signal (default ~/vault).
      --auth-predicate <p>  Unified-log predicate for the failed-auths signal.
      --icloud-dir <dir>    Folder for the phone's snapshot (default iCloud Drive/guardian_opacity).
      --no-icloud           Don't write the phone's snapshot.

    Example:
      guardian --headless --opacity --port 8547
    """)
}
