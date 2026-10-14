import { useState, useEffect, useRef } from "react";

// ── Guardian · Hunter Mode ───────────────────────────────────────────────────
// A sweep-radar watch over four simulated signal channels. Each channel's raw
// sample is smoothed by a moving average; when the filtered value strays past
// THRESHOLD from BASELINE the channel reads ANOMALY and a contact is placed on
// the scope. The operator walks each contact DETECTED → ACQUIRED → NEUTRALIZED.
// The signals are synthesized locally. Sol, the prompt under the top bar, is
// Claude: it reads the Guardian daemon's /status (through Vite's /daemon proxy)
// plus this console's state, and answers the operator. Sol only reads.

const MONO = "'JetBrains Mono', 'Courier New', ui-monospace, monospace";

const BUFFER_LIMIT = 10;
const MAX_CONTACTS = 9;  // log length; only neutralized contacts are evicted
const STACK_BELOW = 720; // px; narrower viewports stack the panels vertically
const BASELINE = 1.0;
const THRESHOLD = 0.35;

// Background noise alone can never trip the detector: every noise sample lies
// in [0.65, 1.35), so no average of them can stray more than 0.35 from
// BASELINE. Contacts come from disturbances — a sustained offset on one channel
// that the moving average picks up after several ticks.
const NOISE_LO = 0.65;
const NOISE_SPAN = 0.7;
const DISTURB_CHANCE = 0.006;        // per channel per tick (~every 30s per channel)
const DISTURB_TICKS = [15, 40];      // duration, in 200ms ticks
const DISTURB_OFFSET = [0.5, 0.65];  // magnitude; sign is random

const CHANNELS = [
  { id: "CH-A", freq: 820, label: "ALPHA" },
  { id: "CH-B", freq: 1240, label: "BETA" },
  { id: "CH-C", freq: 440, label: "GAMMA" },
  { id: "CH-D", freq: 2100, label: "DELTA" },
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
- Facts about the daemon come ONLY from the DAEMON STATUS JSON in the message. Never invent fields, values, history or causes it does not show. If DAEMON STATUS is "unreachable", say the daemon cannot be reached and do not describe its state.
- The console's channels and contacts are SIMULATED signals synthesized in the browser, not sensor data. Never present them as real detections; say they are simulated when it matters to the answer.
- You can read the daemon and the console but cannot change either. Never claim to have acted.
- reply <= 60 words, plain and direct.
- grounding: integer 0-3 = how much of the reply rests on the provided status and console data (0 none — general talk, or the daemon is unreachable and the answer needed it; 3 read entirely from the data).

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

const randIn = ([lo, hi]) => lo + Math.random() * (hi - lo);

// GET the daemon's status JSON, or null when it can't be reached in time.
async function readDaemon() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DAEMON_TIMEOUT_MS);
  try {
    const r = await fetch(DAEMON_STATUS_URL, { signal: ctrl.signal, cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

// Advance one channel's disturbance state and return its next raw sample.
function sample(d) {
  if (d.ticks > 0) {
    d.ticks--;
  } else if (Math.random() < DISTURB_CHANCE) {
    d.ticks = Math.round(randIn(DISTURB_TICKS));
    d.offset = (Math.random() < 0.5 ? -1 : 1) * randIn(DISTURB_OFFSET);
  }
  const noise = NOISE_LO + Math.random() * NOISE_SPAN;
  return noise + (d.ticks > 0 ? d.offset : 0);
}

function useHunter() {
  const buffers = useRef({});
  const disturbances = useRef({});
  const lastStatus = useRef({});
  const [channels, setChannels] = useState(() =>
    CHANNELS.map(c => ({ ...c, signal: 1.0, filtered: 1.0, status: "clear", history: [] }))
  );
  const [targets, setTargets] = useState([]);
  const [radarAngle, setRadarAngle] = useState(0);

  useEffect(() => {
    const loop = setInterval(() => {
      setRadarAngle(a => (a + 2.5) % 360);

      // Sample and filter here rather than inside the setChannels updater:
      // StrictMode runs updaters twice, which would double-push every sample.
      const readings = {};
      CHANNELS.forEach(({ id }) => {
        if (!buffers.current[id]) buffers.current[id] = [];
        if (!disturbances.current[id]) disturbances.current[id] = { ticks: 0, offset: 0 };
        const raw = sample(disturbances.current[id]);
        const buf = buffers.current[id];
        buf.push(raw);
        if (buf.length > BUFFER_LIMIT) buf.shift();
        readings[id] = { raw, avg: buf.reduce((a, b) => a + b, 0) / buf.length };
      });

      setChannels(prev => prev.map(ch => {
        const { raw, avg } = readings[ch.id];
        const unstable = Math.abs(avg - BASELINE) > THRESHOLD;
        return {
          ...ch, signal: raw, filtered: avg,
          status: unstable ? "anomaly" : "clear",
          history: [...(ch.history || []).slice(-30), avg],
        };
      }));
    }, 200);
    return () => clearInterval(loop);
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
        return capLog([...prev, {
          id: `TGT-${Date.now()}-${ch.id}`,
          chId: ch.id,
          label: ch.label,
          angle, r,
          x: 50 + r * 47 * Math.cos((angle * Math.PI) / 180),
          y: 50 + r * 47 * Math.sin((angle * Math.PI) / 180),
          status: "detected",
          delta: (ch.filtered - BASELINE).toFixed(3),
          ts: new Date().toISOString().slice(11, 19),
          hits: 1,
        }], MAX_CONTACTS);
      });
    });
  }, [channels]);

  const acquire = (id) => setTargets(p => p.map(t => t.id === id ? { ...t, status: "acquired" } : t));
  const neutralize = (id) => setTargets(p => p.map(t => t.id === id ? { ...t, status: "neutralized" } : t));

  return { channels, targets, radarAngle, acquire, neutralize };
}

const MiniWave = ({ history, anomaly }) => {
  const W = 80, H = 24;
  const pts = history.map((v, i) => {
    const x = (i / (history.length - 1 || 1)) * W;
    const y = H / 2 - (v - BASELINE) * 35;
    return `${x},${Math.max(1, Math.min(H - 1, y))}`;
  }).join(" ");
  const c = anomaly ? "255,100,60" : "100,200,140";
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
      <line x1={0} y1={H/2} x2={W} y2={H/2} stroke={`rgba(${c},0.1)`} strokeWidth={0.5} />
      {history.length > 1 && (
        <polyline points={pts} fill="none"
          stroke={`rgba(${c},0.9)`} strokeWidth={1}
          style={{ filter: `drop-shadow(0 0 2px rgba(${c},1))` }} />
      )}
    </svg>
  );
};

function useDaemon() {
  const [status, setStatus] = useState(undefined); // undefined: not checked yet; null: unreachable
  useEffect(() => {
    let live = true, timer;
    const poll = async () => {
      const s = await readDaemon();
      if (!live) return;
      setStatus(s);
      timer = setTimeout(poll, s ? DAEMON_POLL_MS : DAEMON_OFFLINE_POLL_MS);
    };
    poll();
    return () => { live = false; clearTimeout(timer); };
  }, []);
  return [status, setStatus];
}

function consoleSnapshot(channels, targets) {
  const ch = channels.map(c =>
    `${c.label} ${c.status} filtered=${c.filtered.toFixed(3)} delta=${(c.filtered - BASELINE).toFixed(3)}`);
  const open = targets.filter(t => t.status !== "neutralized").map(t =>
    `${t.label} ${t.status} delta=${t.delta} hits=${t.hits} since ${t.ts} UTC`);
  return `channels (simulated):\n${ch.join("\n")}\nopen contacts:\n${open.length ? open.join("\n") : "none"}`;
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
          onKeyDown={(e) => { if (e.key === "Enter") speak(); }}
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
          <div style={{ flex: 1, fontSize: 11, lineHeight: 1.6, color: "rgba(255,220,150,0.92)" }}>
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
        <div style={{ fontSize: 10, color: "rgba(255,100,60,0.9)", userSelect: "text" }}>{err}</div>
      )}
      {!result && raw && (
        <pre style={{
          margin: 0, fontSize: 10, whiteSpace: "pre-wrap", color: "rgba(126,200,135,0.6)",
          fontFamily: "inherit", userSelect: "text",
        }}>{raw}</pre>
      )}
    </div>
  );
};

export default function HunterMode() {
  const { channels, targets, radarAngle, acquire, neutralize } = useHunter();
  const narrow = useNarrow(STACK_BELOW);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 60);
    return () => clearInterval(t);
  }, []);

  const activeTargets = targets.filter(t => t.status !== "neutralized");
  const totalAnomalies = channels.filter(c => c.status === "anomaly").length;

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
          <span style={{ fontSize: 9, letterSpacing: "0.3em", color: totalAnomalies > 0 ? "#FF6440" : "#7EC887", opacity: 0.8 }}>
            {totalAnomalies > 0 ? `● ${totalAnomalies} ANOMAL${totalAnomalies > 1 ? "IES" : "Y"}` : "● ALL CLEAR"}
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
          {channels.map(ch => {
            const anom = ch.status === "anomaly";
            const c = anom ? "255,100,60" : "100,200,140";
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
                <MiniWave history={ch.history} anomaly={anom} />
                <div style={{ flex: 1, display: "flex", gap: narrow ? 12 : 20, justifyContent: "flex-end" }}>
                  {[
                    { l: "RAW", v: ch.signal.toFixed(3) },
                    { l: "FILT", v: ch.filtered.toFixed(3) },
                    { l: "δ", v: (ch.filtered - BASELINE >= 0 ? "+" : "") + (ch.filtered - BASELINE).toFixed(3) },
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
