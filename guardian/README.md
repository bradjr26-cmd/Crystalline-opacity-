# Guardian (headless daemon)

The Mac Mini M4 vault-node daemon for Kibler AI Solutions Corp.
Public harness — the CrystallineOpacity math is sealed out via `.gitignore`.

> This is a self-contained SwiftPM package living in the `guardian/`
> subdirectory of the repo. Run all commands below from inside `guardian/`.

## Build & run
```bash
cd guardian
swift build -c release
swift run guardian --headless --opacity --port 8547
```

Then, in another terminal:
```bash
curl localhost:8547/status
curl localhost:8547/signals
```

## Flags
- `--headless` — run as daemon (required for LaunchAgent keepalive)
- `--opacity`  — enable crystalline-soma pipeline (φ-basis). Omit for calibrated-only.
- `--port N`   — status endpoint port (default 8547)
- `--iface IF` — interface whose outbound connections `/signals` counts (default `en0`)
- `--vault DIR` — evidence vault whose ledger `/signals` re-hashes (default `~/vault`)
- `--auth-predicate P` — unified-log predicate for failed auths (default in `SignalProbe.swift`)

## Signals (Hunter Mode's channels)
`GET /signals` returns the latest sample of three real signals; `GET /signals?history=1`
adds the last 24 h of 5-second samples, which Hunter Mode uses to learn each
channel's baseline. Counts only — no user names, addresses, paths or file names —
because the port is served on the LAN. A source that is down reports
`"value": null` with a `note`, **never 0**.

| Channel | Source | Value |
|---|---|---|
| `failed_auths` | `log stream --style ndjson --predicate …` (sshd / sshd-session, sudo, Screen Sharing) | matching events in the last 5 s |
| `outbound` | `netstat -anW -p tcp` + the interface's addresses (`getifaddrs`) | ESTABLISHED connections from en0 whose local port nothing listens on |
| `hash_drift` | `~/vault/integrity.log` (`action: ingest`) + `~/vault/documents/` | tampered + missing + unreadable files, re-hashed with SHA-256 every 60 s |

The probe is read-only: it never acts on what it sees. `log stream` runs as the
LaunchAgent's user, so run Guardian from an admin account.

### Verify each channel on the M4 (after the first build)
This code was type-checked and run on Linux (the parser, the vault re-hash and the
`/signals` JSON), but `log stream`, `netstat` and en0 only exist on the Mac, so check:

1. `curl -s localhost:8547/signals | python3 -m json.tool`: all three channels should show `"ok": true`.
   A `note` says why one isn't (for example `log stream exited (status …)`).
2. **failed_auths**: in another terminal run `sudo -k; sudo true` and type a wrong password.
   Within 5 s `failed_auths.value` should be at least 1. If it stays 0, watch the raw stream while you
   repeat it, `log stream --style ndjson --predicate '<predicate>'`, adjust the wording, and pass it with
   `--auth-predicate`.
3. **outbound**: compare with `netstat -anW -p tcp | grep ESTABLISHED | grep "$(ipconfig getifaddr en0)\."`
   (minus any inbound connections to ports you listen on, like 22 or 8547).
4. **hash_drift**: never test on the real evidence vault. Make a throwaway one: copy
   `~/vault/integrity.log` and `~/vault/documents/` to `~/vault-test/`, run a second instance with
   `--vault ~/vault-test --port 8548`, append a byte to one file in `~/vault-test/documents/`, and
   within 60 s `curl -s localhost:8548/signals` should show `hash_drift.value` = 1.

## Files
| File | Role |
|------|------|
| `Package.swift` | SwiftPM executable manifest (macOS 13+) |
| `Sources/guardian/main.swift` | Entry shim — dispatches headless vs usage |
| `Sources/guardian/GuardianHeadless.swift` | Daemon loop, banner, log rotation |
| `Sources/guardian/GuardianEngine.swift` | Public harness — cycle loop, state, status JSON |
| `Sources/guardian/StatusServer.swift` | Read-only HTTP `/status` and `/signals` endpoints (BSD sockets) |
| `Sources/guardian/SignalProbe.swift` | Failed auths, outbound connections on en0, vault hash drift → `/signals` |
| `com.kibler.guardian.plist` | LaunchAgent — boot on login, KeepAlive |
| `.gitignore` | Seals the patented soma math out of the repo |

## The sealed soma
The four novel patent elements (φ-spiral basis, polar dipole transform,
coherence-coupled soma, φ-decay expansion) are NOT in this repo. They go in:

    Sources/guardian/GuardianEngine+Opacity.swift   (gitignored)

implementing `func opacityStep(cycle:) -> Double`, then wire it into
`opacityStepIfAvailable(cycle:)`. Without that file the daemon falls back
to the calibrated path and still builds, runs, and serves status — so the
public repo is fully functional without exposing the IP.

## Install the LaunchAgent
```bash
# edit the binary path in the plist first, then:
cp com.kibler.guardian.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.kibler.guardian.plist
launchctl list | grep guardian
```

## NOTE
Structure-verified and dependency-free, but compile it on the M4 — that
first `swift build` is the real confirmation. `StatusServer.swift` uses the
Darwin POSIX socket API, so it is macOS-only by design.
