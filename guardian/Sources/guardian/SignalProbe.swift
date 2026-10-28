import Foundation
import CryptoKit
import Darwin

// ============================================================
// SignalProbe — the real channels Hunter Mode watches (GET /signals)
//
// Every `sampleSeconds` the probe takes one sample of three signals on
// this Mac and keeps the last 24 h of them:
//
//   failed_auths   authentication failures in the macOS unified log
//                  during the last sample window. A long-running
//                  `log stream` filtered by `authPredicate` feeds a
//                  counter; each sample takes the count and resets it.
//   outbound       established TCP connections whose local address is
//                  one of the interface's (en0 by default) and whose
//                  local port nothing listens on — i.e. this Mac dialled
//                  out. Read from `netstat -anW -p tcp`.
//   hash_drift     evidence-vault files (Guardian's ~/vault, see vault.js)
//                  whose SHA-256 no longer matches the hash recorded at
//                  ingest in integrity.log, plus recorded files that are
//                  missing or unreadable. Re-hashed every `hashSeconds`.
//
// READ-ONLY: the probe observes and counts. It never acts on what it sees.
// COUNTS ONLY: /signals is served on 0.0.0.0 like /status, so it carries no
// user names, addresses, paths or file names — just numbers and the health
// of each source.
// NO FAKE ZEROS: a source that is down (log stream exited, netstat failed,
// the interface has no address, no integrity.log) reports value null with a
// note, never 0. A dead sensor that reads "all clear" is how the original
// Hunter Mode lied.
//
// THE PHONE PATH: the Mac mini is airgapped, so nothing reaches /signals from
// outside it. The probe also judges every sample itself — the same baseline
// rule Hunter Mode uses — and writes a small snapshot, hunter_signals.json,
// into the iCloud Drive folder guardian_opacity/ (one writer: this daemon;
// the phone's signals.jsonl is never touched). The iPhone widget
// (guardian/phone/hunter_widget.js) reads it. The snapshot carries the last
// 24 h of crossings, because a widget refreshes every few minutes and must not
// miss a 10-second burst between refreshes.
// ============================================================

struct SignalConfig {
    var interface = "en0"
    var vaultDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("vault")
    var authPredicate = SignalProbe.defaultAuthPredicate
    // Where the phone's snapshot goes; nil = don't write one.
    var snapshotDir: URL? = SignalConfig.defaultSnapshotDir()

    // iCloud Drive's root on macOS, plus the folder the rest of the stack uses.
    // Only if iCloud Drive is actually there: writing into a folder that doesn't
    // sync would look like it works while the phone never sees a thing.
    static func defaultSnapshotDir() -> URL? {
        let root = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs")
        guard FileManager.default.fileExists(atPath: root.path) else { return nil }
        return root.appendingPathComponent("guardian_opacity")
    }
}

final class SignalProbe {

    static let sampleSeconds = 5
    static let hashSeconds = 60
    static let historyLength = 24 * 3600 / sampleSeconds      // 24 h of samples

    // The baseline rule. These MUST match src/HunterMode.jsx (K_SPREAD, MIN_STEP,
    // CALIBRATION_MIN) so the phone and the console judge a sample the same way:
    //   threshold = median + max(kSpread × 1.4826 × MAD, minStep)
    // over the channel's history; calibrating until calibrationMin readings.
    // hash_drift has no learned baseline: the vault ledger is its baseline,
    // so any drift (≥ 1 file) is an anomaly.
    static let kSpread = 4.0
    static let minStep = 1.0
    static let calibrationMin = 60

    // The phone's snapshot.
    static let snapshotName = "hunter_signals.json"
    static let snapshotSeconds = 60                            // and at once on a new event
    static let eventWindowSeconds = 24 * 3600
    static let eventCap = 200
    static let sparkSamples = 60                               // last 5 min per channel

    // Failed logins on the paths a headless Mac Mini exposes: SSH (sshd, or
    // sshd-session on OpenSSH 9.8+), sudo, and Screen Sharing. It matches each
    // message's fixed text, which the unified log keeps even when it redacts the
    // user name and address. Local password failures at the login window are not
    // included: their wording varies by macOS version. Override with
    // --auth-predicate after checking with `log stream --predicate '...'`.
    static let defaultAuthPredicate = """
    (process BEGINSWITH "sshd" AND (eventMessage CONTAINS[c] "failed password" \
    OR eventMessage CONTAINS[c] "invalid user" \
    OR eventMessage CONTAINS[c] "authentication error" \
    OR eventMessage CONTAINS[c] "authentication failure")) \
    OR (process == "sudo" AND eventMessage CONTAINS[c] "incorrect password") \
    OR (process == "screensharingd" AND eventMessage CONTAINS[c] "authentication: failed")
    """

    private struct Reading {
        var value: Int?          // nil = no reading (the source is down)
        var note: String
    }

    struct Baseline {
        let center: Double
        let threshold: Double
        let n: Int               // readings it was measured on
        let calibrating: Bool
    }

    private let config: SignalConfig
    private let queue = DispatchQueue(label: "guardian.signals", qos: .utility)
    private let hashQueue = DispatchQueue(label: "guardian.signals.hash", qos: .background)
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?
    private var hashTimer: DispatchSourceTimer?

    // failed_auths: fed by the log stream between samples
    private var authProcess: Process?
    private var authUp = false
    private var authNote = "starting log stream"
    private var authPending = 0
    private var authLineBuffer = Data()

    // latest readings
    private var auth = Reading(value: nil, note: "not sampled yet")
    private var net = Reading(value: nil, note: "not sampled yet")
    private var drift = Reading(value: nil, note: "not hashed yet")
    private var driftDetail: [String: Any] = [:]
    private var sampledAt = 0

    // history, oldest first; nil where a source had no reading
    private var historyT: [Int] = []
    private var historyAuth: [Int?] = []
    private var historyNet: [Int?] = []
    private var historyDrift: [Int?] = []

    // judgement of the latest sample, and crossings over the last 24 h
    private var lastStatus: [String: String] = [:]
    private var lastBaseline: [String: Baseline] = [:]
    private var events: [[String: Any]] = []
    private var lastSnapshotAt = 0
    private var snapshotOK: Bool? = nil                        // nil = not written yet
    private var snapshotNote = ""

    init(config: SignalConfig) {
        self.config = config
    }

    // MARK: - Lifecycle

    func start() {
        startAuthStream()

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .seconds(SignalProbe.sampleSeconds),
                   repeating: .seconds(SignalProbe.sampleSeconds))
        t.setEventHandler { [weak self] in self?.sample() }
        t.resume()
        timer = t

        // Hash once right away, then every hashSeconds, on its own queue so a large
        // vault never delays a sample.
        let h = DispatchSource.makeTimerSource(queue: hashQueue)
        h.schedule(deadline: .now() + 1, repeating: .seconds(SignalProbe.hashSeconds))
        h.setEventHandler { [weak self] in self?.rehashVault() }
        h.resume()
        hashTimer = h
    }

    // MARK: - One sample

    private func sample() {
        let netReading = sampleOutbound()            // runs netstat; keep it outside the lock

        lock.lock()
        auth = authUp ? Reading(value: authPending, note: "") : Reading(value: nil, note: authNote)
        authPending = 0
        net = netReading
        sampledAt = Int(Date().timeIntervalSince1970)

        historyT.append(sampledAt)
        historyAuth.append(auth.value)
        historyNet.append(net.value)
        historyDrift.append(drift.value)
        let extra = historyT.count - SignalProbe.historyLength
        if extra > 0 {
            historyT.removeFirst(extra)
            historyAuth.removeFirst(extra)
            historyNet.removeFirst(extra)
            historyDrift.removeFirst(extra)
        }

        let fresh = judge()
        var snapshot: Data? = nil
        if config.snapshotDir != nil,
           fresh || sampledAt - lastSnapshotAt >= SignalProbe.snapshotSeconds {
            snapshot = snapshotData()
            lastSnapshotAt = sampledAt
        }
        lock.unlock()

        if let data = snapshot { writeSnapshot(data) }   // file I/O outside the lock
    }

    // MARK: - Judgement (the same rule as Hunter Mode)

    static func median(_ sorted: [Double]) -> Double {
        let n = sorted.count, m = n / 2
        return n % 2 == 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
    }

    static func baseline(_ history: [Int?], ledger: Bool) -> Baseline {
        if ledger { return Baseline(center: 0, threshold: 1, n: history.count, calibrating: false) }
        let xs = history.compactMap { $0 }.map(Double.init).sorted()
        guard xs.count >= calibrationMin else {
            return Baseline(center: 0, threshold: 0, n: xs.count, calibrating: true)
        }
        let center = median(xs)
        let mad = median(xs.map { abs($0 - center) }.sorted())
        return Baseline(center: center, threshold: center + max(kSpread * 1.4826 * mad, minStep),
                        n: xs.count, calibrating: false)
    }

    static func status(_ value: Int?, _ b: Baseline) -> String {
        guard let v = value else { return "no-signal" }
        if b.calibrating { return "calibrating" }
        return Double(v) >= b.threshold ? "anomaly" : "clear"
    }

    // Judge the sample just taken; log a crossing (→ anomaly) or a lost source
    // (→ no-signal) as an event. Returns true when something new was logged.
    // Call with the lock held.
    private func judge() -> Bool {
        var fresh = false
        let table: [(key: String, value: Int?, note: String, history: [Int?], ledger: Bool)] = [
            ("failed_auths", auth.value, auth.note, historyAuth, false),
            ("outbound", net.value, net.note, historyNet, false),
            ("hash_drift", drift.value, drift.note, historyDrift, true),
        ]
        for ch in table {
            let b = SignalProbe.baseline(ch.history, ledger: ch.ledger)
            let st = SignalProbe.status(ch.value, b)
            let was = lastStatus[ch.key]
            if st == "anomaly", was != "anomaly", let v = ch.value {
                events.append(["t": sampledAt, "channel": ch.key, "kind": "anomaly",
                               "value": v, "threshold": b.threshold])
                fresh = true
            } else if st == "no-signal", let w = was, w != "no-signal" {
                events.append(["t": sampledAt, "channel": ch.key, "kind": "no-signal", "note": ch.note])
                fresh = true
            }
            lastStatus[ch.key] = st
            lastBaseline[ch.key] = b
        }
        let cutoff = sampledAt - SignalProbe.eventWindowSeconds
        events.removeAll { ($0["t"] as? Int ?? 0) < cutoff }
        if events.count > SignalProbe.eventCap { events.removeFirst(events.count - SignalProbe.eventCap) }
        return fresh
    }

    // MARK: - The phone's snapshot (iCloud Drive)

    // Call with the lock held.
    private func snapshotData() -> Data? {
        func channel(_ key: String, _ r: Reading, _ history: [Int?], extra: [String: Any]) -> [String: Any] {
            var d: [String: Any] = [
                "value": r.value.map { $0 as Any } ?? NSNull(),
                "ok": r.value != nil,
                "status": lastStatus[key] ?? "no-signal",
                "spark": history.suffix(SignalProbe.sparkSamples).map { $0.map { $0 as Any } ?? NSNull() },
            ]
            if let b = lastBaseline[key] {
                d["n"] = b.n
                if !b.calibrating { d["center"] = b.center; d["threshold"] = b.threshold }
            }
            if !r.note.isEmpty { d["note"] = r.note }
            for (k, v) in extra { d[k] = v }
            return d
        }
        let body: [String: Any] = [
            "service": "guardian",
            "version": 1,
            "written_at": Int(Date().timeIntervalSince1970),
            "sampled_at": sampledAt,
            "interval_s": SignalProbe.sampleSeconds,
            "calibration_min": SignalProbe.calibrationMin,
            "channels": [
                "failed_auths": channel("failed_auths", auth, historyAuth, extra: ["window_s": SignalProbe.sampleSeconds]),
                "outbound": channel("outbound", net, historyNet, extra: ["interface": config.interface]),
                "hash_drift": channel("hash_drift", drift, historyDrift, extra: ["baseline": "ledger"]),
            ],
            "events": events,
        ]
        return try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }

    private func writeSnapshot(_ data: Data) {
        guard let dir = config.snapshotDir else { return }
        var ok = true, note = ""
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try data.write(to: dir.appendingPathComponent(SignalProbe.snapshotName), options: .atomic)
        } catch {
            // Usually macOS privacy: a LaunchAgent binary needs Full Disk Access
            // (or Files and Folders → iCloud Drive) to write into iCloud Drive.
            ok = false
            note = "could not write the iCloud snapshot - give the guardian binary Full Disk Access"
        }
        lock.lock()
        let changed = snapshotOK != ok
        snapshotOK = ok
        snapshotNote = note
        lock.unlock()
        if changed { print(ok ? "[SignalProbe] iCloud snapshot written." : "[SignalProbe] \(note)") }
    }

    // MARK: - failed_auths (log stream)

    private func startAuthStream() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/log")
        p.arguments = ["stream", "--style", "ndjson", "--predicate", config.authPredicate]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty { self?.consumeAuth(data) }
        }
        p.terminationHandler = { [weak self] proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            self?.authStreamEnded("log stream exited (status \(proc.terminationStatus))")
        }
        do {
            try p.run()
            lock.lock()
            authProcess = p
            authUp = true
            authNote = ""
            lock.unlock()
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            authStreamEnded("could not start log stream")
        }
    }

    // ndjson: one JSON object per matching event. Anything else (the
    // "Filtering the log data using ..." header) is not an event.
    private func consumeAuth(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        authLineBuffer.append(data)
        while let nl = authLineBuffer.firstIndex(of: 0x0A) {
            let line = authLineBuffer[authLineBuffer.startIndex..<nl]
            if line.first == UInt8(ascii: "{") { authPending += 1 }
            authLineBuffer.removeSubrange(authLineBuffer.startIndex...nl)
        }
    }

    private func authStreamEnded(_ why: String) {
        lock.lock()
        authUp = false
        authNote = why
        authProcess = nil
        authLineBuffer.removeAll()
        lock.unlock()
        print("[SignalProbe] \(why); retrying in 30 s")
        queue.asyncAfter(deadline: .now() + 30) { [weak self] in self?.startAuthStream() }
    }

    // MARK: - outbound (netstat)

    private func sampleOutbound() -> Reading {
        let addresses = SignalProbe.addresses(of: config.interface)
        if addresses.isEmpty {
            return Reading(value: nil, note: "\(config.interface) has no address")
        }
        guard let result = SignalProbe.run("/usr/sbin/netstat", ["-anW", "-p", "tcp"]),
              result.status == 0 else {
            return Reading(value: nil, note: "netstat failed")
        }
        return Reading(value: SignalProbe.countOutbound(netstat: result.output, localAddresses: addresses),
                       note: "")
    }

    // Each tcp line of `netstat -anW -p tcp` is
    //   Proto Recv-Q Send-Q Local-Address Foreign-Address (state)
    // with the port after the LAST dot of an address (192.168.1.5.52344,
    // fe80::1c3a:ab%en0.4910). Outbound = ESTABLISHED, on one of the
    // interface's addresses, from a local port nothing is listening on.
    static func countOutbound(netstat: String, localAddresses: Set<String>) -> Int {
        var listeningPorts = Set<String>()
        var established: [(addr: String, port: String)] = []
        for line in netstat.split(separator: "\n") {
            let fields = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
            guard fields.count >= 6, fields[0].hasPrefix("tcp"),
                  let local = splitHostPort(String(fields[3])) else { continue }
            switch fields[5] {
            case "LISTEN": listeningPorts.insert(local.port)
            case "ESTABLISHED": established.append(local)
            default: break
            }
        }
        return established.filter {
            localAddresses.contains($0.addr) && !listeningPorts.contains($0.port)
        }.count
    }

    static func splitHostPort(_ s: String) -> (addr: String, port: String)? {
        guard let dot = s.lastIndex(of: ".") else { return nil }
        var addr = String(s[..<dot])
        if let pct = addr.firstIndex(of: "%") { addr = String(addr[..<pct]) }  // drop the %en0 scope
        return (addr, String(s[s.index(after: dot)...]))
    }

    static func addresses(of interface: String) -> Set<String> {
        var out = Set<String>()
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return out }
        defer { freeifaddrs(head) }
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let ifa = ptr.pointee
            guard String(cString: ifa.ifa_name) == interface, let sa = ifa.ifa_addr else { continue }
            let family = Int32(sa.pointee.sa_family)
            guard family == AF_INET || family == AF_INET6 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count),
                              nil, 0, NI_NUMERICHOST) == 0 else { continue }
            var s = String(cString: host)
            if let pct = s.firstIndex(of: "%") { s = String(s[..<pct]) }
            out.insert(s)
        }
        return out
    }

    // MARK: - hash_drift (vault ledger)

    private func rehashVault() {
        let ledger = config.vaultDir.appendingPathComponent("integrity.log")
        let docs = config.vaultDir.appendingPathComponent("documents")
        guard let text = try? String(contentsOf: ledger, encoding: .utf8) else {
            setDrift(Reading(value: nil, note: "no integrity.log in the vault folder"), detail: [:])
            return
        }
        var checked = 0, tampered = 0, missing = 0, unreadable = 0
        for line in text.split(separator: "\n") {
            guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  obj["action"] as? String == "ingest",
                  let name = obj["vault_filename"] as? String,
                  let recorded = (obj["hash"] as? String)?.lowercased() else { continue }
            checked += 1
            let file = docs.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: file.path) else { missing += 1; continue }
            // A file that can't be read can't be verified: count it as drift (fail closed).
            guard let digest = SignalProbe.sha256Hex(of: file) else { unreadable += 1; continue }
            if digest != recorded { tampered += 1 }
        }
        setDrift(Reading(value: tampered + missing + unreadable, note: ""),
                 detail: ["checked": checked, "tampered": tampered, "missing": missing,
                          "unreadable": unreadable, "checked_at": Int(Date().timeIntervalSince1970)])
    }

    private func setDrift(_ reading: Reading, detail: [String: Any]) {
        lock.lock()
        drift = reading
        driftDetail = detail
        lock.unlock()
    }

    static func sha256Hex(of url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk: Data?
            do { chunk = try handle.read(upToCount: 1 << 20) } catch { return nil }
            guard let bytes = chunk, !bytes.isEmpty else { break }
            hasher.update(data: bytes)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Helpers

    static func run(_ path: String, _ args: [String]) -> (status: Int32, output: String)? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()   // drain first, or a full pipe deadlocks
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    // MARK: - Snapshot (read by StatusServer)

    func signalsJSON(includeHistory: Bool) -> String {
        lock.lock(); defer { lock.unlock() }

        func channel(_ r: Reading, source: String, extra: [String: Any] = [:]) -> [String: Any] {
            var d: [String: Any] = [
                "value": r.value.map { $0 as Any } ?? NSNull(),
                "ok": r.value != nil,
                "source": source,
            ]
            if !r.note.isEmpty { d["note"] = r.note }
            for (k, v) in extra { d[k] = v }
            return d
        }

        var snapshot: [String: Any] = ["enabled": config.snapshotDir != nil,
                                       "ok": snapshotOK.map { $0 as Any } ?? NSNull(),
                                       "last_written": lastSnapshotAt]
        if !snapshotNote.isEmpty { snapshot["note"] = snapshotNote }
        var body: [String: Any] = [
            "service": "guardian",
            "interval_s": SignalProbe.sampleSeconds,
            "sampled_at": sampledAt,
            "snapshot": snapshot,
            "channels": [
                "failed_auths": channel(auth, source: "log stream",
                                        extra: ["window_s": SignalProbe.sampleSeconds]),
                "outbound": channel(net, source: "netstat", extra: ["interface": config.interface]),
                "hash_drift": channel(drift, source: "vault integrity.log", extra: driftDetail),
            ],
        ]
        if includeHistory {
            let column: ([Int?]) -> [Any] = { $0.map { $0.map { $0 as Any } ?? NSNull() } }
            body["history"] = [
                "t": historyT,
                "failed_auths": column(historyAuth),
                "outbound": column(historyNet),
                "hash_drift": column(historyDrift),
            ]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else {
            return #"{"error":"could not encode signals"}"#
        }
        return String(decoding: data, as: UTF8.self)
    }
}
