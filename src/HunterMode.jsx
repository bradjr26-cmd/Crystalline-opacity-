import { useState, useEffect, useRef, useMemo } from "react";

// ── Guardian · Hunter Mode ───────────────────────────────────────────────────
// A sweep-radar watch over three REAL signal channels the Guardian daemon
// measures on the Mac (guardian/Sources/guardian/SignalProbe.swift, GET /signals):
//   AUTH  failed authentications in the unified log, per 5 s sample
//   NET   established outbound TCP connections on en0
//   HASH  evidence-vault files whose SHA-256 no longer matches the ledger
// Each channel's threshold is set from this machine's own measured baseline,
// not a constant. When a channel crosses it, a contact goes on the scope and
// the operator walks it DETECTED → ACQUIRED → NEUTRALIZED. Nothing here is
// synthesized: a source that is down reads NO SIGNAL, never zero. Sol, the
// prompt under the top bar, is Claude: it reads the daemon's /status plus this
// console's state, and answers the operator. Sol only reads.

const MONO = "'JetBrains Mono', 'Courier New', ui-monospace, monospace";

const MAX_CONTACTS = 9;  // log length; only neutralized contacts are evicted
const STACK_BELOW = 720; // px; narrower viewports stack the panels vertically

// ── Signals ──────────────────────────────────────────────────────────────────
// Reached through vite.config.js's /daemon proxy, like Sol's /status.
const SIGNALS_URL = "/daemon/signals";
const SIGNAL_POLL_MS = 5000;           // the daemon samples every 5 s
const SIGNAL_OFFLINE_POLL_MS = 30000;  // back off while it's unreachable (each miss is a proxy error in dev)
const HISTORY_TIMEOUT_MS = 8000;       // the first read carries up to 24 h of samples
const HISTORY_CAP = 17280;             // 24 h of 5 s samples, the same as the daemon keeps
const SPARK_SAMPLES = 60;              // each row's sparkline shows the last 5 min

// Thresholds come from the machine's own baseline, not a constant:
//   threshold = median + max(K_SPREAD × 1.4826 × MAD, MIN_STEP)
// over every sample the daemon has kept (up to 24 h). Median and MAD (median
// absolute deviation) shrug off the anomalies inside the window. MIN_STEP keeps a
// perfectly quiet channel (MAD 0) from alarming on nothing: it must rise by at
// least one whole count. HASH has no learned baseline: the vault ledger IS its
// SHA-256 baseline, so a single drifted file is an anomaly by definition.
const K_SPREAD = 4;
const MIN_STEP = 1;
const CALIBRATION_MIN = 60;            // 5 min of samples before a learned threshold is trusted

const CHANNELS = [
  { id: "CH-A", key: "failed_auths", label: "AUTH", what: "failed authentications / 5 s", baseline: "learned" },
  { id: "CH-B", key: "outbound",     label: "NET",  what: "outbound TCP connections",     baseline: "learned" },
  { id: "CH-C", key: "hash_drift",   label: "HASH", what: "vault files off their SHA-256", baseline: "ledger" },
];

// ── Sol ──────────────────────────────────────────────────────────────────────
// The Guardian daemon (guardian/, port 8547) serves GET /status without CORS
// headers, so the browser reaches it same-origin through vite.config.js's
// /daemon proxy. Sol is Claude, called directly from the browser like the
// turret; its key stays in this browser.
const DAEMON_STATUS_URL = "/daemon/status";
const DAEMON_POLL_MS = 10000;
const DAEMON_OFFLINE_POLL_MS = 60000; // back off: each failed poll also logs a proxy error in the dev server
const DAEMON_TIMEOUT_MS = 2500;

const SOL_MODEL = "claude-opus-5-5";

const SOL_SYSTEM = `You are Sol, the voice of a Guardian "Hunter Mode" console. The operator speaks to you; you answer about the Guardian daemon and the console. Return ONLY a JSON object — no prose, no markdown, no backticks.

GROUND RULES:
- Facts come ONLY from the DAEMON STATUS JSON and the CONSOLE section in the message. Never invent fields, values, history or causes they do not show. If DAEMON STATUS is "unreachable", say the daemon cannot be reached and do not describe its state.
- The console's channels are REAL counts the daemon measured on this Mac: AUTH = failed authentications in the last 5 s, NET = established outbound TCP connections on the named interface, HASH = evidence-vault files whose SHA-256 no longer matches the ledger (or are missing). AUTH and NET thresholds are learned from the machine's own baseline; HASH alarms on any drift. A threshold crossing is an anomaly to look at, not proof of an attack: never claim an intrusion, name an attacker, or give a cause the data does not show. A channel with no reading, or still calibrating, tells you nothing about that signal — say so.
- You can read the daemon and the console but cannot change either. Never claim to have acted.
- reply <= 60 words, plain and direct.
- grounding: integer 0-3 = how much of the reply rests on the provided status and console data (0 none — general talk, or the data the answer needed is missing; 3 read entirely from the data).

Return EXACTLY:
{"reply":"...","grounding":N}`;

const SOL_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    grounding: { type: "integer", enum: [0, 1, 2, 3] },
  },
  required: ["reply", "grounding"],
  additionalProperties: false,
};

const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

// GET the daemon's status JSON, or null when it can't be reached in time.
async function readDaemon() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DAEMON_TIMEOUT_MS);
  try {
    // The daemon needs no cookies; don't carry other localhost apps' cookies to GUARDIAN_URL.
    const r = await fetch(DAEMON_STATUS_URL, { signal: ctrl.signal, cache: "no-store", credentials: "omit" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// GET /signals. Tells an unreachable daemon apart from an old build without the route.
async function readSignals(withHistory) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), withHistory ? HISTORY_TIMEOUT_MS : DAEMON_TIMEOUT_MS);
  try {
    const r = await fetch(withHistory ? `${SIGNALS_URL}?history=1` : SIGNALS_URL,
      { signal: ctrl.signal, cache: "no-store", credentials: "omit" });
    if (r.status === 404) return { ok: false, phase: "no-endpoint", note: "the daemon answers but has no /signals — rebuild guardian" };
    if (!r.ok) return { ok: false, phase: "offline", note: `daemon unreachable (HTTP ${r.status})` };
    return { ok: true, data: await r.json() };
  } catch {
    return { ok: false, phase: "offline", note: "daemon unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

const valueOf = (data, key) => {
  const v = data?.channels?.[key]?.value;
  return typeof v === "number" ? v : null;
};

// Pure (setState updaters run twice under StrictMode). The daemon's own history
// replaces ours when it sends one; otherwise the new sample is appended once.
function mergeHistory(prev, data) {
  const h = data.history;
  if (h && Array.isArray(h.t)) {
    const out = { t: h.t.slice(-HISTORY_CAP) };
    CHANNELS.forEach(c => { out[c.key] = (h[c.key] || []).slice(-HISTORY_CAP).map(v => (typeof v === "number" ? v : null)); });
    return out;
  }
  const t = data.sampled_at;
  if (!t) return prev;                                       // the daemon hasn't sampled yet
  if (prev && prev.t.length && t <= prev.t[prev.t.length - 1]) return prev;   // same sample again
  const base = prev || { t: [], ...Object.fromEntries(CHANNELS.map(c => [c.key, []])) };
  const cut = base.t.length >= HISTORY_CAP ? 1 : 0;
  const out = { t: [...base.t.slice(cut), t] };
  CHANNELS.forEach(c => { out[c.key] = [...base[c.key].slice(cut), valueOf(data, c.key)]; });
  return out;
}

// Poll /signals: the first good read asks for the daemon's history, later ones
// only for the latest sample. One timer, backed off while the daemon is down.
function useSignals() {
  const [feed, setFeed] = useState({ phase: "connecting", note: "", latest: null, history: null });
  useEffect(() => {
    let live = true, timer, seeded = false;
    const poll = async () => {
      const r = await readSignals(!seeded);
      if (!live) return;
      if (r.ok) {
        if (r.data.history) seeded = true;
        setFeed(f => ({ phase: "live", note: "", latest: r.data, history: mergeHistory(f.history, r.data) }));
      } else {
        setFeed(f => ({ ...f, phase: r.phase, note: r.note }));
      }
      timer = setTimeout(poll, r.ok ? SIGNAL_POLL_MS : SIGNAL_OFFLINE_POLL_MS);
    };
    poll();
    return () => { live = false; clearTimeout(timer); };
  }, []);
  return feed;
}

const median = (sorted) => {
  const n = sorted.length, m = n >> 1;
  return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

// The channel's resting level and the line it has to cross, from its own history.
function measureBaseline(values, kind) {
  if (kind === "ledger") return { center: 0, spread: 0, threshold: 1, n: values.length, calibrating: false };
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length < CALIBRATION_MIN) return { n: xs.length, calibrating: true };
  const center = median(xs);
  const spread = 1.4826 * median(xs.map(x => Math.abs(x - center)).sort((a, b) => a - b));
  return { center, spread, threshold: center + Math.max(K_SPREAD * spread, MIN_STEP), n: xs.length, calibrating: false };
}

// Live channel rows: current value, learned baseline, and a status that never
// pretends — no reading is "no-signal", too little history is "calibrating".
function useChannels(feed) {
  return useMemo(() => CHANNELS.map(c => {
    const values = feed.history?.[c.key] || [];
    const src = feed.latest?.channels?.[c.key];
    const value = feed.phase === "live" ? valueOf(feed.latest, c.key) : null;
    const base = measureBaseline(values, c.baseline);
    const status = value === null ? "no-signal"
      : base.calibrating ? "calibrating"
      : value >= base.threshold ? "anomaly" : "clear";
    const note = feed.phase !== "live" ? feed.note
      : value === null ? (src?.note || "no reading")
      : base.calibrating ? `calibrating ${base.n}/${CALIBRATION_MIN}` : "";
    const what = c.key === "outbound" && src?.interface ? `outbound TCP connections on ${src.interface}` : c.what;
    return { ...c, what, value, base, status, note, spark: values.slice(-SPARK_SAMPLES) };
  }), [feed]);
}

// Trim the log to `max` by dropping the oldest neutralized contacts. Unresolved
// contacts are never evicted, so the operator can always still act on them.
function capLog(list, max) {
  let excess = list.length - max;
  return excess <= 0 ? list : list.filter(t => t.status !== "neutralized" || excess-- <= 0);
}

function useNarrow(px) {
  const query = `(max-width: ${px - 1}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

function useHunter() {
  const feed = useSignals();
  const channels = useChannels(feed);
  const lastStatus = useRef({});
  const [targets, setTargets] = useState([]);
  const [radarAngle, setRadarAngle] = useState(0);

  useEffect(() => {
    const sweep = setInterval(() => setRadarAngle(a => (a + 2.5) % 360), 200);
    return () => clearInterval(sweep);
  }, []);

  // Spawn a target when a channel trips (clear → anomaly). A channel that stays
  // anomalous doesn't respawn a contact the operator has already neutralized,
  // and a channel that re-trips while its contact is still open bumps that
  // contact's hit count instead of stacking a second one.
  useEffect(() => {
    channels.forEach(ch => {
      const was = lastStatus.current[ch.id];
      lastStatus.current[ch.id] = ch.status;
      if (ch.status !== "anomaly" || was === "anomaly") return;
      setTargets(prev => {
        const exists = prev.find(t => t.chId === ch.id && t.status !== "neutralized");
        if (exists) return prev.map(t => t === exists ? { ...t, hits: t.hits + 1 } : t);
        const angle = Math.random() * 360;
        const r = 0.3 + Math.random() * 0.55;
        const d = ch.value - ch.base.center;
        return capLog([...prev, {
          id: `TGT-${Date.now()}-${ch.id}`,
          chId: ch.id,
          label: ch.label,
          angle, r,
          x: 50 + r * 47 * Math.cos((angle * Math.PI) / 180),
          y: 50 + r * 47 * Math.sin((angle * Math.PI) / 180),
          status: "detected",
          delta: `${d >= 0 ? "+" : ""}${fmt(d)}`,
          value: ch.value,
          ts: new Date().toISOString().slice(11, 19),
          hits: 1,
        }], MAX_CONTACTS);
      });
    });
  }, [channels]);

  const acquire = (id) => setTargets(p => p.map(t => t.id === id ? { ...t, status: "acquired" } : t));
  const neutralize = (id) => setTargets(p => p.map(t => t.id === id ? { ...t, status: "neutralized" } : t));

  return { feed, channels, targets, radarAngle, acquire, neutralize };
}

const STATUS_RGB = {
  anomaly: "255,100,60",
  clear: "100,200,140",
  calibrating: "255,200,60",
  "no-signal": "80,120,90",
};

// Counts are never negative, so the sparkline's floor is 0 and its ceiling is
// whichever is higher: the recent peak or a little above the threshold (dashed).
const MiniWave = ({ values, threshold, c }) => {
  const W = 80, H = 24;
  const finite = values.filter(Number.isFinite);
  const top = Math.max(1, ...finite, Number.isFinite(threshold) ? threshold * 1.25 : 0);
  const y = v => H - 1 - (v / top) * (H - 2);
  const pts = values
    .map((v, i) => (Number.isFinite(v) ? `${(i / (values.length - 1 || 1)) * W},${y(v)}` : null))
    .filter(Boolean).join(" ");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block", flexShrink: 0 }}>
      <line x1={0} y1={H - 1} x2={W} y2={H - 1} stroke={`rgba(${c},0.1)`} strokeWidth={0.5} />
      {Number.isFinite(threshold) && (
        <line x1={0} y1={y(threshold)} x2={W} y2={y(threshold)}
          stroke={`rgba(${c},0.35)`} strokeWidth={0.5} strokeDasharray="2 2" />
      )}
      {finite.length > 1 && (
        <polyline points={pts} fill="none"
          stroke={`rgba(${c},0.9)`} strokeWidth={1}
          style={{ filter: `drop-shadow(0 0 2px rgba(${c},1))` }} />
      )}
    </svg>
  );
};

// Returns [status, report]. report(s) records a status read elsewhere (speak()
// reads the daemon fresh) and re-arms the poll at the cadence that status calls
// for, so a prompt that finds the daemon back up doesn't wait out the offline
// back-off. One timer: a poll still in flight can't start a second loop.
function useDaemon() {
  const [status, setStatus] = useState(undefined); // undefined: not checked yet; null: unreachable
  const report = useRef(() => {});
  useEffect(() => {
    let live = true, timer;
    const apply = (s) => {
      setStatus(s);
      clearTimeout(timer);
      timer = setTimeout(poll, s ? DAEMON_POLL_MS : DAEMON_OFFLINE_POLL_MS);
    };
    const poll = async () => {
      const s = await readDaemon();
      if (live) apply(s);
    };
    report.current = (s) => { if (live) apply(s); };
    poll();
    return () => { live = false; clearTimeout(timer); };
  }, []);
  return [status, (s) => report.current(s)];
}

function consoleSnapshot(channels, targets) {
  const ch = channels.map(c => {
    const b = c.base;
    const reading = c.value === null ? `no reading (${c.note})`
      : b.calibrating ? `now=${c.value}, baseline still calibrating (${b.n}/${CALIBRATION_MIN} samples)`
      : `now=${c.value} baseline=${fmt(b.center)} threshold=${fmt(b.threshold)}`;
    return `${c.label} (${c.what}): ${c.status}, ${reading}`;
  });
  const open = targets.filter(t => t.status !== "neutralized").map(t =>
    `${t.label} ${t.status} value=${t.value} delta=${t.delta} hits=${t.hits} since ${t.ts} UTC`);
  return `channels (real counts from the daemon's /signals, thresholds from this machine's own baseline):\n${ch.join("\n")}\nopen contacts:\n${open.length ? open.join("\n") : "none"}`;
}

const SolBar = ({ channels, targets, narrow }) => {
  const [apiKey, setApiKey] = useState(import.meta.env.VITE_ANTHROPIC_API_KEY || "");
  const [daemon, setDaemon] = useDaemon();
  const [input, setInput] = useState("");
  const [result, setResult] = useState(null);
  const [raw, setRaw] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const speak = async () => {
    const q = input.trim();
    if (!q || loading) return;
    if (!apiKey.trim()) { setErr("Enter an Anthropic API key first."); return; }
    setLoading(true); setErr(""); setResult(null); setRaw("");
    try {
      const status = await readDaemon();
      setDaemon(status);
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey.trim(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-beta": "server-side-fallback-2026-07-01",
        },
        body: JSON.stringify({
          model: SOL_MODEL,
          max_tokens: 16000,
          system: SOL_SYSTEM,
          output_config: { effort: "low", format: { type: "json_schema", schema: SOL_SCHEMA } },
          fallbacks: "default",
          messages: [{
            role: "user",
            content: `DAEMON STATUS:\n${status ? JSON.stringify(status) : "unreachable"}\n\nCONSOLE:\n${consoleSnapshot(channels, targets)}\n\nOPERATOR:\n${q}`,
          }],
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setErr(`API error ${resp.status}: ${data?.error?.message || JSON.stringify(data)}`);
        return;
      }
      if (data.stop_reason === "refusal") {
        setErr(`Sol declined to answer${data.stop_details?.category ? ` (${data.stop_details.category})` : ""}.`);
        return;
      }
      const text = (data.content || [])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n").trim();
      setRaw(text);
      const a = text.indexOf("{"), z = text.lastIndexOf("}");
      if (a !== -1 && z !== -1) setResult(JSON.parse(text.slice(a, z + 1)));
      else setErr("Could not parse Sol's reply — showing raw output below.");
    } catch (e) {
      setErr("Sol failed: " + (e?.message || "unknown error"));
    } finally {
      setLoading(false);
    }
  };

  const checking = daemon === undefined;
  const pill = checking ? "○ DAEMON …"
    : daemon ? `● DAEMON · ${String(daemon.mode ?? "?").toUpperCase()} · CYCLE ${daemon.cycle ?? "?"}`
    : "○ DAEMON OFFLINE";
  const pillColor = checking ? "rgba(126,200,135,0.5)" : daemon ? "#7EC887" : "#FF6440";
  const grounding = result?.grounding ?? 0;
  const groundColor = grounding >= 3 ? "100,200,140" : grounding >= 1 ? "255,200,60" : "255,100,60";
  const field = {
    background: "rgba(100,200,140,0.03)", border: "1px solid rgba(100,200,140,0.15)",
    color: "#7EC887", fontFamily: "inherit", fontSize: 11, padding: "6px 10px", outline: "none",
  };

  return (
    <div style={{
      padding: narrow ? "10px 16px" : "10px 24px",
      borderBottom: "1px solid rgba(100,200,140,0.12)",
      display: "flex", flexDirection: "column", gap: 8,
      flexShrink: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 9, letterSpacing: "0.4em", color: "rgba(255,200,60,0.85)" }}>SOL ›</span>
        {!import.meta.env.VITE_ANTHROPIC_API_KEY && (
          <input
            className="hm-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-… key · stays in-browser"
            style={{ ...field, width: narrow ? "100%" : 170, boxSizing: "border-box" }}
          />
        )}
        <input
          className="hm-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Skip the Enter that commits an IME composition (keyCode 229 on Safari).
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) speak();
          }}
          placeholder="speak to sol — ask about the daemon or the scope"
          style={{ ...field, flex: "1 1 220px", minWidth: 0 }}
        />
        <button onClick={speak} disabled={loading} style={{
          padding: "6px 14px", fontSize: 8, letterSpacing: "0.25em",
          background: "transparent", border: "1px solid rgba(255,200,60,0.4)",
          color: "rgba(255,200,60,0.85)", cursor: loading ? "wait" : "pointer",
          fontFamily: "inherit", opacity: loading ? 0.5 : 1,
        }}>{loading ? "READING…" : "SPEAK"}</button>
        <span style={{ fontSize: 8, letterSpacing: "0.25em", color: pillColor, opacity: 0.75, whiteSpace: "nowrap" }}>
          {pill}
        </span>
      </div>

      {loading && (
        <div style={{ fontSize: 9, letterSpacing: "0.2em", color: "rgba(255,200,60,0.5)" }}>
          ◌ sol is reading the daemon…
        </div>
      )}
      {result && (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", userSelect: "text" }}>
          <div style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", fontSize: 11, lineHeight: 1.6, color: "rgba(255,220,150,0.92)" }}>
            {result.reply}
          </div>
          <div style={{ flexShrink: 0, textAlign: "right" }}>
            <div style={{ fontSize: 7, letterSpacing: "0.2em", opacity: 0.3, marginBottom: 4 }}>GROUNDING</div>
            <div style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
              {[1, 2, 3].map(n => (
                <div key={n} style={{
                  width: 10, height: 4,
                  background: `rgba(${groundColor},${n <= grounding ? 0.85 : 0.12})`,
                }} />
              ))}
            </div>
          </div>
        </div>
      )}
      {err && (
        <div style={{ fontSize: 10, color: "rgba(255,100,60,0.9)", userSelect: "text", overflowWrap: "anywhere" }}>{err}</div>
      )}
      {!result && raw && (
        <pre style={{
          margin: 0, fontSize: 10, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "rgba(126,200,135,0.6)",
          fontFamily: "inherit", userSelect: "text",
        }}>{raw}</pre>
      )}
    </div>
  );
};

export default function HunterMode() {
  const { feed, channels, targets, radarAngle, acquire, neutralize } = useHunter();
  const narrow = useNarrow(STACK_BELOW);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 60);
    return () => clearInterval(t);
  }, []);

  const activeTargets = targets.filter(t => t.status !== "neutralized");
  const count = (st) => channels.filter(c => c.status === st).length;
  const anomalies = count("anomaly"), calibrating = count("calibrating"), noSignal = count("no-signal");
  const live = channels.length - noSignal;
  // The headline never claims more than the channels show: "ALL CLEAR" only when
  // every channel has a reading, and a missing source is always named.
  const headline =
    feed.phase === "offline" ? { text: "○ NO SIGNAL · DAEMON UNREACHABLE", rgb: STATUS_RGB["no-signal"] }
    : feed.phase === "no-endpoint" ? { text: "○ NO SIGNAL · DAEMON HAS NO /signals", rgb: STATUS_RGB["no-signal"] }
    : feed.phase === "connecting" ? { text: "○ CONNECTING TO DAEMON…", rgb: STATUS_RGB["no-signal"] }
    : anomalies ? { text: `● ${anomalies} ANOMAL${anomalies > 1 ? "IES" : "Y"}`, rgb: STATUS_RGB.anomaly }
    : calibrating ? { text: "◐ CALIBRATING BASELINE", rgb: STATUS_RGB.calibrating }
    : live ? { text: noSignal ? "● CLEAR" : "● ALL CLEAR", rgb: STATUS_RGB.clear }
    : { text: "○ NO SIGNAL", rgb: STATUS_RGB["no-signal"] };
  const headlineSuffix = feed.phase === "live" && noSignal && live ? ` · ${noSignal} NO SIGNAL` : "";

  return (
    <div style={{
      minHeight: "100vh",
      background: "#030A04",
      color: "#7EC887",
      fontFamily: MONO,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      position: "relative",
      userSelect: "none",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');
        input.hm-input::placeholder{color:rgba(126,200,135,0.3)}
      `}</style>

      {/* CRT scanlines */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none", zIndex: 100,
        backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.07) 2px, rgba(0,0,0,0.07) 4px)",
      }} />

      {/* Top bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 24px",
        borderBottom: "1px solid rgba(100,200,140,0.12)",
        background: "rgba(100,200,140,0.02)",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
          <span style={{ fontSize: 9, letterSpacing: "0.4em", opacity: 0.4 }}>GUARDIAN</span>
          <span style={{ fontSize: 9, letterSpacing: "0.3em", color: `rgb(${headline.rgb})`, opacity: 0.85 }}>
            {headline.text}{headlineSuffix}
          </span>
        </div>
        <div style={{ display: "flex", gap: 20, fontSize: 8, opacity: 0.3, letterSpacing: "0.25em" }}>
          <span>HUNT MODE</span>
          <span>{new Date().toISOString().slice(11, 19)} UTC</span>
        </div>
      </div>

      <SolBar channels={channels} targets={targets} narrow={narrow} />

      <div style={{
        display: "flex", flex: 1,
        flexDirection: narrow ? "column" : "row",
        overflow: narrow ? "visible" : "hidden",
      }}>

        {/* Left: Radar */}
        <div style={{
          width: narrow ? "auto" : 280, flexShrink: 0,
          [narrow ? "borderBottom" : "borderRight"]: "1px solid rgba(100,200,140,0.1)",
          display: "flex", flexDirection: "column",
          alignItems: "center",
          padding: "24px 0",
          gap: 16,
        }}>
          <div style={{ fontSize: 8, letterSpacing: "0.35em", opacity: 0.35 }}>SWEEP RADAR</div>

          {/* Radar circle */}
          <div style={{ position: "relative", width: 200, height: 200 }}>
            <svg width={200} height={200} viewBox="0 0 100 100" style={{ position: "absolute", inset: 0 }}>
              {/* Grid rings */}
              {[20, 35, 47].map(r => (
                <circle key={r} cx={50} cy={50} r={r} fill="none"
                  stroke="rgba(100,200,140,0.1)" strokeWidth={0.4} />
              ))}
              {/* Cross hairs */}
              <line x1={50} y1={3} x2={50} y2={97} stroke="rgba(100,200,140,0.08)" strokeWidth={0.3} />
              <line x1={3} y1={50} x2={97} y2={50} stroke="rgba(100,200,140,0.08)" strokeWidth={0.3} />

              {/* Sweep sector + leading edge */}
              <g transform={`rotate(${radarAngle}, 50, 50)`}>
                <path
                  d={`M 50 50 L ${50 + 47 * Math.cos(-Math.PI/6)} ${50 + 47 * Math.sin(-Math.PI/6)} A 47 47 0 0 1 ${50 + 47} 50 Z`}
                  fill="rgba(100,200,140,0.07)"
                />
                <line x1={50} y1={50}
                  x2={50 + 47} y2={50}
                  stroke="rgba(100,200,140,0.7)"
                  strokeWidth={0.6}
                  style={{ filter: "drop-shadow(0 0 3px rgba(100,200,140,0.9))" }}
                />
              </g>

              {/* Targets as blips */}
              {activeTargets.map(t => {
                const isAcquired = t.status === "acquired";
                const pulse = 0.5 + Math.sin(tick * 0.15) * 0.5;
                return (
                  <g key={t.id}>
                    {isAcquired && (
                      <circle cx={t.x} cy={t.y} r={4 + pulse * 3}
                        fill="none" stroke="rgba(255,100,60,0.3)"
                        strokeWidth={0.4} />
                    )}
                    <circle cx={t.x} cy={t.y} r={isAcquired ? 2 : 1.5}
                      fill={isAcquired ? "rgb(255,100,60)" : "rgb(255,180,60)"}
                      style={{ filter: `drop-shadow(0 0 ${isAcquired ? 4 : 2}px ${isAcquired ? "rgb(255,100,60)" : "rgb(255,200,60)"})` }} />
                    <text x={t.x + 3} y={t.y - 2} fontSize={3.5}
                      fill={isAcquired ? "rgba(255,100,60,0.9)" : "rgba(255,200,60,0.7)"}
                      letterSpacing="0.1em">{t.label}</text>
                  </g>
                );
              })}

              {/* Outer ring */}
              <circle cx={50} cy={50} r={49} fill="none"
                stroke="rgba(100,200,140,0.2)" strokeWidth={0.5} />
            </svg>
          </div>

          <div style={{ fontSize: 8, opacity: 0.2, letterSpacing: "0.2em" }}>
            {activeTargets.length} TARGET{activeTargets.length !== 1 ? "S" : ""} ON SCOPE
          </div>
        </div>

        {/* Center: Channels */}
        <div style={{
          flex: 1,
          padding: narrow ? "24px 16px" : "24px",
          display: "flex", flexDirection: "column", gap: 2,
          overflowY: "auto",
        }}>
          <div style={{ fontSize: 8, letterSpacing: "0.35em", opacity: 0.3, marginBottom: 12 }}>
            SIGNAL CHANNELS
          </div>
          {feed.phase !== "live" && feed.note && (
            <div style={{ fontSize: 8, letterSpacing: "0.15em", opacity: 0.45, marginBottom: 8 }}>{feed.note}</div>
          )}
          {channels.map(ch => {
            const anom = ch.status === "anomaly";
            const c = STATUS_RGB[ch.status];
            const b = ch.base;
            const learned = ch.value !== null && !b.calibrating;
            const d = learned ? ch.value - b.center : null;
            return (
              <div key={ch.id} style={{
                display: "flex", alignItems: "center", gap: narrow ? 10 : 16,
                padding: "10px 14px",
                border: `1px solid rgba(${c},${anom ? 0.25 : 0.08})`,
                background: `rgba(${c},${anom ? 0.04 : 0.01})`,
                transition: "all 0.4s",
              }}>
                <div style={{ width: 48, flexShrink: 0 }}>
                  <div style={{ fontSize: 7, letterSpacing: "0.3em", opacity: 0.4, marginBottom: 2 }}>{ch.id}</div>
                  <div style={{ fontSize: 10, letterSpacing: "0.2em", color: `rgba(${c},0.9)` }}>{ch.label}</div>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <MiniWave values={ch.spark} threshold={learned ? b.threshold : NaN} c={c} />
                  <div style={{ fontSize: 6, letterSpacing: "0.1em", opacity: 0.35, marginTop: 3, maxWidth: 80, overflowWrap: "anywhere" }}>
                    {ch.note || ch.what}
                  </div>
                </div>
                <div style={{ flex: 1, display: "flex", gap: narrow ? 12 : 20, justifyContent: "flex-end" }}>
                  {[
                    { l: "NOW", v: ch.value === null ? "—" : fmt(ch.value) },
                    { l: "BASE", v: learned ? fmt(b.center) : "—" },
                    { l: "THR", v: learned ? fmt(b.threshold) : "—" },
                    { l: "δ", v: d === null ? "—" : `${d >= 0 ? "+" : ""}${fmt(d)}` },
                  ].map(({ l, v }) => (
                    <div key={l} style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 7, opacity: 0.25, letterSpacing: "0.2em", marginBottom: 2 }}>{l}</div>
                      <div style={{ fontSize: 10, color: `rgba(${c},0.8)` }}>{v}</div>
                    </div>
                  ))}
                </div>
                <div style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: `rgb(${c})`,
                  opacity: anom ? 0.9 : 0.3,
                  flexShrink: 0,
                  boxShadow: anom ? `0 0 6px rgb(${c})` : "none",
                  transition: "all 0.4s",
                }} />
              </div>
            );
          })}
        </div>

        {/* Right: Target log */}
        <div style={{
          width: narrow ? "auto" : 220, flexShrink: 0,
          [narrow ? "borderTop" : "borderLeft"]: "1px solid rgba(100,200,140,0.1)",
          display: "flex", flexDirection: "column",
          padding: "24px 0",
        }}>
          <div style={{ fontSize: 8, letterSpacing: "0.35em", opacity: 0.3, padding: "0 16px", marginBottom: 12 }}>
            TARGET LOG
          </div>
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, padding: "0 8px" }}>
            {targets.length === 0 && (
              <div style={{ fontSize: 8, opacity: 0.2, letterSpacing: "0.2em", textAlign: "center", marginTop: 20 }}>
                NO CONTACTS
              </div>
            )}
            {[...targets].reverse().map(t => {
              const c = t.status === "acquired" ? "255,100,60"
                : t.status === "neutralized" ? "80,120,90"
                : "255,200,60";
              return (
                <div key={t.id} style={{
                  padding: "8px 10px",
                  border: `1px solid rgba(${c},${t.status === "neutralized" ? 0.1 : 0.2})`,
                  opacity: t.status === "neutralized" ? 0.4 : 1,
                  transition: "all 0.5s",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 8, color: `rgba(${c},0.9)`, letterSpacing: "0.2em" }}>{t.label}</span>
                    <span style={{ fontSize: 7, opacity: 0.35 }}>{t.ts}</span>
                  </div>
                  <div style={{ fontSize: 7, opacity: 0.4, letterSpacing: "0.15em", marginBottom: 6 }}>
                    δ {t.delta} · {t.chId}{t.hits > 1 ? ` · ×${t.hits}` : ""}
                  </div>
                  {t.status !== "neutralized" && (
                    <div style={{ display: "flex", gap: 4 }}>
                      {t.status === "detected" && (
                        <button onClick={() => acquire(t.id)} style={{
                          flex: 1, padding: "3px 0", fontSize: 7,
                          background: "transparent", border: "1px solid rgba(255,200,60,0.4)",
                          color: "rgba(255,200,60,0.8)", letterSpacing: "0.2em",
                          cursor: "pointer", fontFamily: "inherit",
                        }}>ACQUIRE</button>
                      )}
                      {t.status === "acquired" && (
                        <button onClick={() => neutralize(t.id)} style={{
                          flex: 1, padding: "3px 0", fontSize: 7,
                          background: "rgba(255,100,60,0.1)", border: "1px solid rgba(255,100,60,0.5)",
                          color: "rgba(255,100,60,0.9)", letterSpacing: "0.2em",
                          cursor: "pointer", fontFamily: "inherit",
                        }}>NEUTRALIZE</button>
                      )}
                    </div>
                  )}
                  {t.status === "neutralized" && (
                    <div style={{ fontSize: 7, letterSpacing: "0.2em", opacity: 0.4 }}>◼ NEUTRALIZED</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
