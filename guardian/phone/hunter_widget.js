// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-green; icon-glyph: satellite-dish;
// Guardian · Hunter: the airgapped Mac mini's three signals on the Home Screen.
// The daemon writes hunter_signals.json into iCloud Drive/guardian_opacity/; this
// only reads it. Setup is in guardian/README.md ("Hunter on the iPhone").

const BOOKMARK = "guardian_opacity"   // Scriptable → Settings → File Bookmarks
const SNAPSHOT = "hunter_signals.json"
const STALE_MINUTES = 15              // the daemon writes at least once a minute
const CACHE_FILE = "hunter-widget-last.json"

const STATUS_COLORS = { anomaly: "FF6440", clear: "7DF9C8", calibrating: "FBBF24", "no-signal": "5E6E68" }
const STALE = "5E6E68"
const TEXT = "E4ECE9"
const DIM = "8E9C97"

const CHANNELS = [
  { key: "failed_auths", label: "AUTH", what: "failed auths / 5 s" },
  { key: "outbound", label: "NET", what: "outbound connections" },
  { key: "hash_drift", label: "HASH", what: "vault files off SHA-256" },
]

async function main() {
  let r = await readSnapshot()
  if (config.runsInWidget) {
    Script.setWidget(buildWidget(r))
    return
  }
  await menu(r)
}

// ── reading the snapshot ────────────────────────────────────────────────────
// The daemon judges every sample itself (same rule as the Hunter Mode console);
// the phone only adds one thing it alone can know: how old the snapshot is.

async function readSnapshot() {
  let fm = FileManager.iCloud()
  if (!fm.bookmarkExists(BOOKMARK)) {
    return { problem: `Add a File Bookmark named "${BOOKMARK}" for iCloud Drive/guardian_opacity: Scriptable → Settings → File Bookmarks.` }
  }
  let path = fm.joinPath(fm.bookmarkedPath(BOOKMARK), SNAPSHOT)
  try {
    if (!fm.fileExists(path)) {
      return fromCache(`No ${SNAPSHOT} in guardian_opacity yet. Is the Mac mini's daemon running with iCloud Drive?`)
    }
    await fm.downloadFileFromiCloud(path)
    let snap = JSON.parse(fm.readString(path))
    if (!snap || snap.service != "guardian" || !snap.channels) throw new Error("not a Guardian snapshot")
    saveCache(snap)
    return { snap }
  } catch (e) {
    return fromCache(`Couldn't read ${SNAPSHOT}: ${e.message}`)
  }
}

// The widget keeps its last good snapshot, so a sync hiccup shows the last
// known reading (marked stale by its own age) instead of nothing.
function fromCache(problem) {
  let snap = loadCache()
  return snap ? { snap, problem } : { problem }
}

function cachePath() {
  let fm = FileManager.local()
  return fm.joinPath(fm.documentsDirectory(), CACHE_FILE)
}

function saveCache(snap) {
  try {
    FileManager.local().writeString(cachePath(), JSON.stringify(snap))
  } catch (e) {}
}

function loadCache() {
  try {
    let fm = FileManager.local()
    return fm.fileExists(cachePath()) ? JSON.parse(fm.readString(cachePath())) : null
  } catch (e) {
    return null
  }
}

// ── reading it out ──────────────────────────────────────────────────────────

function ageMinutes(snap) {
  return (Date.now() - snap.written_at * 1000) / 60000
}

// Never claims more than the snapshot shows: a stale snapshot is STALE, not
// clear; "ALL CLEAR" only when every channel has a reading.
function headline(r) {
  let snap = r.snap
  if (!snap) return { text: "○ NO SNAPSHOT", hex: STALE }
  if (ageMinutes(snap) > STALE_MINUTES) return { text: `○ STALE · ${ageText(snap)}`, hex: STALE }
  let st = CHANNELS.map(c => (snap.channels[c.key] || {}).status || "no-signal")
  let n = s => st.filter(x => x == s).length
  let anomalies = n("anomaly"), calibrating = n("calibrating"), noSignal = n("no-signal")
  let live = st.length - noSignal
  let suffix = noSignal && live ? ` · ${noSignal} NO SIGNAL` : ""
  if (anomalies) return { text: `● ${anomalies} ANOMAL${anomalies > 1 ? "IES" : "Y"}${suffix}`, hex: STATUS_COLORS.anomaly }
  if (calibrating) return { text: `◐ CALIBRATING${suffix}`, hex: STATUS_COLORS.calibrating }
  if (live) return { text: noSignal ? `● CLEAR${suffix}` : "● ALL CLEAR", hex: STATUS_COLORS.clear }
  return { text: "○ NO SIGNAL", hex: STALE }
}

function ageText(snap) {
  let m = ageMinutes(snap)
  if (m < 1) return "just now"
  if (m < 60) return `${Math.round(m)} min ago`
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`
  return `${Math.round(m / 1440)} d ago`
}

const fmt = x => (Number.isInteger(x) ? String(x) : Number(x).toFixed(1))

function channelLine(c, ch) {
  if (!ch || ch.value === null || ch.value === undefined) return `${c.label} —`
  if (ch.status == "calibrating") return `${c.label} ${fmt(ch.value)} · calibrating`
  return `${c.label} ${fmt(ch.value)} / ${fmt(ch.threshold)}`
}

// The crossings the widget would otherwise sleep through between refreshes.
function crossings(snap) {
  let since = Date.now() / 1000 - 24 * 3600
  return (snap.events || []).filter(e => e.kind == "anomaly" && e.t >= since)
}

function labelOf(key) {
  return (CHANNELS.find(c => c.key == key) || { label: key }).label
}

function clock(t) {
  let d = new Date(t * 1000)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function eventLine(e) {
  return e.kind == "anomaly"
    ? `${labelOf(e.channel)} ${fmt(e.value)} over ${fmt(e.threshold)} at ${clock(e.t)}`
    : `${labelOf(e.channel)} lost its signal at ${clock(e.t)}`
}

// ── the widget ──────────────────────────────────────────────────────────────

function buildWidget(r) {
  let family = config.widgetFamily || "medium"
  let w = new ListWidget()
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000)
  let h = headline(r)
  let snap = r.snap
  let stale = !snap || ageMinutes(snap) > STALE_MINUTES

  if (family.startsWith("accessory")) {
    w.addText(snap ? `${h.text}${stale ? "" : ` · ${ageText(snap)}`}` : h.text)
    return w
  }

  let gradient = new LinearGradient()
  gradient.locations = [0, 1]
  gradient.colors = [new Color("0F1513"), new Color("17221F")]
  w.backgroundGradient = gradient
  w.setPadding(14, 14, 14, 14)

  addText(w, "◈ hunter · mac mini", Font.mediumSystemFont(12), DIM)
  w.addSpacer(4)
  addText(w, h.text, Font.boldSystemFont(family == "small" ? 15 : 18), h.hex).minimumScaleFactor = 0.6
  if (!snap) {
    w.addSpacer(4)
    addText(w, r.problem, Font.systemFont(12), TEXT).lineLimit = 4
    return w
  }
  w.addSpacer(6)

  for (let c of CHANNELS) {
    let ch = snap.channels[c.key] || {}
    let hex = stale ? STALE : STATUS_COLORS[ch.status] || STALE
    let row = w.addStack()
    row.centerAlignContent()
    addText(row, channelLine(c, ch), Font.regularMonospacedSystemFont(family == "small" ? 11 : 12), hex)
    if (family != "small") {
      row.addSpacer()
      let note = ch.value === null || ch.value === undefined ? ch.note || "no reading" : c.what
      addText(row, note, Font.systemFont(10), DIM).lineLimit = 1
    }
  }

  w.addSpacer()
  let recent = crossings(snap)
  if (family != "small") {
    let last = (snap.events || [])[(snap.events || []).length - 1]
    let line = recent.length
      ? `${recent.length} crossing${recent.length > 1 ? "s" : ""} in 24 h · last ${eventLine(recent[recent.length - 1])}`
      : last ? `no crossings in 24 h · ${eventLine(last)}` : "no crossings in 24 h"
    addText(w, line, Font.systemFont(10), recent.length ? STATUS_COLORS.anomaly : DIM).lineLimit = 2
  } else if (recent.length) {
    addText(w, `${recent.length} crossing${recent.length > 1 ? "s" : ""} · 24 h`, Font.systemFont(10), STATUS_COLORS.anomaly)
  }
  let footer = r.problem ? "last known · couldn't refresh" : `sampled ${ageText(snap)}`
  addText(w, footer, Font.systemFont(10), DIM)
  return w
}

function addText(stack, text, font, hex) {
  let t = stack.addText(String(text))
  t.font = font
  t.textColor = new Color(hex)
  return t
}

// ── in the app ──────────────────────────────────────────────────────────────

async function menu(r) {
  let a = new Alert()
  a.title = "Guardian · Hunter"
  a.message = r.snap ? `${headline(r).text}\nsampled ${ageText(r.snap)}` : r.problem
  a.addAction("Show the details")
  a.addAction("Preview the widget")
  a.addCancelAction("Close")
  let choice = await a.presentSheet()
  if (choice == 0) {
    await showText("Hunter details", details(r))
  } else if (choice == 1) {
    await buildWidget(r).presentMedium()
  }
}

function details(r) {
  if (!r.snap) return r.problem
  let snap = r.snap
  let lines = [headline(r).text, `sampled ${ageText(snap)}`]
  if (r.problem) lines.push(`(${r.problem})`)
  lines.push("")
  for (let c of CHANNELS) {
    let ch = snap.channels[c.key] || {}
    let base = ch.status == "calibrating" ? `calibrating ${ch.n || 0}/${snap.calibration_min || 60}`
      : ch.threshold !== undefined ? `baseline ${fmt(ch.center)}, threshold ${fmt(ch.threshold)}` : ""
    lines.push(`${channelLine(c, ch)} · ${ch.status || "no-signal"}`)
    lines.push(`  ${[c.what, base, ch.note].filter(Boolean).join(" · ")}`)
  }
  let events = (snap.events || []).slice(-10).reverse()
  lines.push("", events.length ? "Last crossings (24 h):" : "No crossings or lost signals in 24 h.")
  events.forEach(e => lines.push(`  ${eventLine(e)}`))
  return lines.join("\n")
}

async function showText(title, message) {
  let a = new Alert()
  a.title = title
  a.message = message
  a.addCancelAction("OK")
  await a.presentAlert()
}

// Runs last, so every constant above is initialized first.
await main()
Script.complete()
