import Foundation

// ============================================================
// StatusServer — read-only HTTP /status endpoint (BSD sockets)
//
// Deliberately tiny and dependency-free: no Network.framework, no
// third-party HTTP library, just the POSIX socket API that ships
// with Darwin. The daemon is launched by a LaunchAgent on a vault
// node, so the fewer moving parts the better.
//
// Contract (kept identical to the original call site in
// GuardianHeadless.swift):
//
//     let server = StatusServer(port: port, engine: engine, probe: probe)
//     server.start()
//
// Behaviour:
//   GET /status            -> 200, application/json, body = engine.statusJSON()
//   GET /signals           -> 200, the latest sample of Hunter Mode's channels
//   GET /signals?history=1 -> 200, the same plus the last 24 h of samples
//   GET <other>            -> 404, application/json
//   <other verb>           -> 405, application/json
//
// The server is READ-ONLY. It never mutates the engine or the probe; it
// only calls their thread-safe snapshots (statusJSON, signalsJSON). It binds to
// 0.0.0.0 so `curl localhost:<port>/status` works from any local
// terminal, and accepts connections serially on a background queue —
// a status probe has no need for concurrency.
// ============================================================

final class StatusServer {

    private let port: UInt16
    private let engine: GuardianEngine
    private let probe: SignalProbe?

    // The accept loop runs here so start() returns immediately and the
    // caller can drop into RunLoop.main.run().
    private let queue = DispatchQueue(label: "guardian.status", qos: .utility)

    init(port: UInt16, engine: GuardianEngine, probe: SignalProbe? = nil) {
        self.port = port
        self.engine = engine
        self.probe = probe
    }

    // MARK: - Lifecycle

    func start() {
        queue.async { [weak self] in
            self?.serveForever()
        }
    }

    // MARK: - Socket setup + accept loop

    private func serveForever() {
        // 1. Create a TCP socket.
        let listenFD = socket(AF_INET, SOCK_STREAM, 0)
        guard listenFD >= 0 else {
            perror("[StatusServer] socket")
            return
        }

        // 2. Allow immediate rebinding after a restart (avoids "Address
        //    already in use" while the previous socket lingers in TIME_WAIT).
        var yes: Int32 = 1
        setsockopt(listenFD, SOL_SOCKET, SO_REUSEADDR,
                   &yes, socklen_t(MemoryLayout<Int32>.size))

        // 3. Bind to 0.0.0.0:<port>. sin_port/sin_addr are network byte
        //    order, hence the .bigEndian conversion and s_addr = 0 (ANY).
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: in_addr_t(0)) // INADDR_ANY

        let bindResult = withUnsafePointer(to: &addr) { rawPtr in
            rawPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                bind(listenFD, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            perror("[StatusServer] bind")
            close(listenFD)
            return
        }

        // 4. Start listening. Backlog of 8 is plenty for a status probe.
        guard listen(listenFD, 8) == 0 else {
            perror("[StatusServer] listen")
            close(listenFD)
            return
        }

        // 5. Accept connections forever, handling each one serially.
        while true {
            let clientFD = accept(listenFD, nil, nil)
            if clientFD < 0 {
                // Transient accept() error (e.g. interrupted syscall) —
                // keep the listener alive rather than tearing it down.
                continue
            }
            handle(clientFD: clientFD)
        }
    }

    // MARK: - Per-connection handling

    private func handle(clientFD: Int32) {
        defer { close(clientFD) }

        // Read the request. A status probe sends a tiny request, so a
        // single 1 KB read covers the request line + headers we care about.
        var buffer = [UInt8](repeating: 0, count: 1024)
        let bytesRead = read(clientFD, &buffer, buffer.count)
        let request = bytesRead > 0
            ? String(decoding: buffer[0..<bytesRead], as: UTF8.self)
            : ""

        let statusLine: String
        let body: String

        if request.hasPrefix("GET /status") {
            statusLine = "HTTP/1.1 200 OK"
            body = engine.statusJSON()
        } else if request.hasPrefix("GET /signals"), let probe = probe {
            statusLine = "HTTP/1.1 200 OK"
            body = probe.signalsJSON(includeHistory: request.hasPrefix("GET /signals?history"))
        } else if request.hasPrefix("GET ") {
            statusLine = "HTTP/1.1 404 Not Found"
            body = #"{"error":"not found","hint":"try GET /status or GET /signals"}"#
        } else {
            statusLine = "HTTP/1.1 405 Method Not Allowed"
            body = #"{"error":"method not allowed","allow":"GET"}"#
        }

        writeResponse(clientFD: clientFD, statusLine: statusLine, body: body)
    }

    private func writeResponse(clientFD: Int32, statusLine: String, body: String) {
        let response = """
        \(statusLine)\r
        Content-Type: application/json\r
        Content-Length: \(body.utf8.count)\r
        Connection: close\r
        \r
        \(body)
        """

        // Write the whole response, looping until every byte is flushed —
        // a single write() may not consume the full buffer.
        let bytes = Array(response.utf8)
        bytes.withUnsafeBufferPointer { ptr in
            guard let base = ptr.baseAddress else { return }
            var offset = 0
            while offset < ptr.count {
                let written = write(clientFD, base + offset, ptr.count - offset)
                if written <= 0 { break } // client gone or error — give up
                offset += written
            }
        }
    }
}
