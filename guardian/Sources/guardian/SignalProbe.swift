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
// ============================================================

struct SignalConfig {
    var interface = "en0"
    var vaultDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("vault")
    var authPredicate = SignalProbe.defaultAuthPredicate
}

final class SignalProbe {

    static let sampleSeconds = 5
    static let hashSeconds = 60
    static let historyLength = 24 * 3600 / sampleSeconds      // 24 h of samples

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

        lock.lock(); defer { lock.unlock() }
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

        var body: [String: Any] = [
            "service": "guardian",
            "interval_s": SignalProbe.sampleSeconds,
            "sampled_at": sampledAt,
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
