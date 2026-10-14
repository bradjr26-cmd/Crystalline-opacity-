# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this repo is

A loose collection of independent artifacts that share a repo, not a single
application. The active project is **live-lens-turret**, a Vite/React SPA
that hosts several small "instrument" tools behind a tab switcher. Alongside
it sit standalone Python analysis scripts, static HTML reports, and an
orphaned Swift UI-test stub — none of which build or run together with the
React app or each other.

When making changes, scope them to the one artifact you're touching. Don't
assume shared tooling, shared config, or a unified test/build pipeline across
the repo — there isn't one.

## Repository layout

```
index.html            Vite entry HTML for the React app
vite.config.js        Vite config (React plugin + /daemon proxy to the Guardian daemon)
package.json          "live-lens-turret" — the only buildable project here
src/
  main.jsx            App shell + tab switcher (the TOOLS registry)
  LiveTurret.jsx      Tool: "the live turret" — three-lens constitutional reader
  GuardianLens.jsx    Tool: "GuardianLens" — bounded multi-agent rigor instrument
  GroundwaterLevels.jsx  Tool: USGS NWIS Ohio groundwater-level viewer
  CrystalComposer.jsx    Tool: "Crystal Composer" — local ballast/Helios/Guardian agent composer
  HunterMode.jsx         Tool: "Hunter Mode" — sweep-radar anomaly watch + Sol (Claude reading the Guardian daemon)
portability_layer.py  Standalone Python skeleton — "canon meeting" form-checker
tidal_lines.py        Standalone Python script — tidal-signal discriminator (has a synthetic self-test)
guardian_hq_topology.html  Standalone static HTML report (network topology record)
CRYSTLLINEUITests.swift   Orphaned Xcode UI-test stub — no surrounding Xcode project in this repo
.env.example          Template for VITE_ANTHROPIC_API_KEY (and optional GUARDIAN_URL)
```

## The React app (live-lens-turret)

Stack: Vite 5 + React 18, no router, no state library, no CSS framework —
everything is inline `style={{ ... }}` objects plus a single injected
`<style>` block per component for `@import`/`@keyframes`/placeholder rules.

### Commands
```
npm install
npm run dev       # vite dev server
npm run build     # production build
npm run preview   # preview the production build
```
There is no test runner, linter, or CI configured for this project. Don't
invent one unless asked — verify changes by running `npm run dev` and
exercising the UI.

### Tab/tool architecture

`src/main.jsx` renders a thin shell with a tab bar driven by a `TOOLS` array:
```js
const TOOLS = [
  { id: "turret", label: "the live turret", component: LiveTurret },
  { id: "guardian", label: "GuardianLens", component: GuardianLens },
  { id: "groundwater", label: "Groundwater Levels", component: GroundwaterLevels },
  { id: "crystal", label: "Crystal Composer", component: CrystalComposer },
  { id: "hunter", label: "Hunter Mode", component: HunterMode },
];
```
Each tool is a single self-contained default-exported component in `src/`.
To add a new tool: create `src/YourTool.jsx`, import it in `main.jsx`, and add
an entry to `TOOLS`. Tools do not share state, context, or styling helpers —
each owns its full visual design independently.

### Conventions shared across tool components

- **Self-contained**: one file per tool, default export, no shared component
  library. Constants (seed prompts, agent/lens definitions, system prompts)
  live at the top of the file as `const` arrays/objects.
- **Inline styling**: all styles are JS objects on `style={{}}`. Each
  component injects one `<style>` block for things inline styles can't do
  (`@import` Google Fonts, `@keyframes`, `::placeholder`). Typeface pairing is
  consistent: **JetBrains Mono** for UI/labels/data, **Fraunces** (italic) for
  headings and reflective copy.
- **Distinct color palettes per tool**: LiveTurret uses a blue-slate night
  palette, GuardianLens a green/olive palette, GroundwaterLevels follows the
  same monospace/dark aesthetic with severity-coded accent colors. When
  editing a tool, match its existing palette rather than introducing new
  colors ad hoc.
- **Standard async-call state shape**: `loading`, `err`/`error`, `result`/`res`,
  and often `raw` (the unparsed model text, shown as a fallback `<pre>` block
  when JSON parsing fails). Keep this shape when adding similar features.

### Anthropic API integration (LiveTurret, GuardianLens, HunterMode's Sol)

These tools call the Anthropic Messages API **directly from the browser**:
```js
fetch("https://api.anthropic.com/v1/messages", {
  headers: {
    "x-api-key": apiKey.trim(),
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    system: SYSTEM,             // long, carefully-worded prompt enforcing strict JSON-only output
    messages: [{ role: "user", content: `...${q}` }],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  }),
})
```
Conventions to preserve when touching this code:
- **API key handling**: read from `import.meta.env.VITE_ANTHROPIC_API_KEY`
  first; if unset, render a password input so the user can paste a key that
  "stays in-browser only." Never hardcode or log a key. `.env.local` (and all
  `.env*.local`) are gitignored — copy `.env.example` to `.env.local` to set
  the key locally; this hides the input field.
- **Strict JSON-only system prompts**: the `SYSTEM` strings explicitly demand
  "ONLY a JSON object — no prose, no markdown, no backticks" and define an
  exact return shape. If you edit a system prompt, preserve this contract —
  the UI parses the response by locating the first `{` and last `}` and
  `JSON.parse`-ing the slice, with the raw text kept as a fallback display.
- **Self-grounding rules baked into prompts**: each "lens"/"agent" persona has
  a hard boundary (e.g. "never invent case names," "use web_search to verify
  before asserting") and numeric self-scores (grant/claim/rigor) that drive
  the UI's gauges and color-coding. These are deliberate epistemic-honesty
  mechanisms — preserve the scoring semantics if you modify a prompt; don't
  loosen the "don't invent authority" language.

HunterMode's Sol uses the same browser `fetch` and key handling, with a newer
request shape: `claude-opus-5-5` at `output_config.effort: "low"`, the reply
constrained by `output_config.format` (a JSON schema matching its `SOL_SYSTEM`
contract), and `fallbacks: "default"` under the
`anthropic-beta: server-side-fallback-2026-07-01` header so a declined request
is retried server-side. It checks `stop_reason === "refusal"` before reading
`content`. It keeps the first-`{`/last-`}` parse and raw `<pre>` fallback.

### GroundwaterLevels (no LLM)

Pure data-fetch/display tool: pulls from the public USGS NWIS API
(`waterservices.usgs.gov`), parses time series client-side, and renders a
sortable/filterable/paginated table. No API key needed. Follow its existing
patterns for `useMemo`-based filtering/sorting and `PAGE_SIZE`-based paging if
extending it.

### CrystalComposer (no LLM, no network)

A purely local instrument: pick facets (character / operations / constraints)
and three bounded stages run over the selection — **ballast** (a constitutional
resting potential weighted toward constraint anchors), **helios** (a debounced
orienting sweep that only runs inside the Van Allen passband and never
authorizes anything), and the **guardian engine** (an A/B-wave read of the
dispersed field against ballast, reporting STABLE or DRIFT). "Deploy" writes an
in-page compiled record only — nothing is sent anywhere, and any change to the
facet set invalidates it. Keep it network-free and keep the gating semantics if
you extend it.

### HunterMode (Sol: Claude + the Guardian daemon)

A local sweep-radar watch over four synthesized signal channels, in a green CRT
palette. Each tick (200ms) every channel takes a raw sample, a `BUFFER_LIMIT`
moving average filters it, and a channel reads ANOMALY when the filtered value
is more than `THRESHOLD` from `BASELINE`. Background noise is bounded so it can
never trip the detector on its own; contacts come only from injected
disturbances (`DISTURB_*`). A contact spawns on a channel's clear → anomaly
edge, and the operator walks it DETECTED → ACQUIRED → NEUTRALIZED. A channel
has at most one open contact: re-tripping while it's open bumps its hit count
(`×n` in the log). The log is capped at `MAX_CONTACTS` by evicting only
neutralized contacts, so an open one never disappears. Below `STACK_BELOW` px
the three panels stack vertically. Sampling happens outside state updaters so
StrictMode's double-invoked updaters stay pure — keep it that way if you touch
the tick loop.

**Sol** is the prompt bar under the top bar: the operator speaks, and Sol
(Claude) answers from the Guardian daemon's `GET /status` plus a snapshot of
the console (channels, open contacts). Sol only reads — the daemon stays
read-only and Sol's prompt forbids claiming to have acted, inventing daemon
facts, or treating the simulated channels as real detections; its `grounding`
self-score (0–3) drives the meter beside each reply. The daemon sends no CORS
headers, so the browser reaches it same-origin through the `/daemon` proxy in
`vite.config.js` (target `GUARDIAN_URL`, default `http://localhost:8547`). The
proxy exists only under `npm run dev` / `npm run preview`; a static build shows
the daemon as offline. The bar polls the daemon every 10s while it's up and
every 60s while it's down, and reads it fresh on every prompt — that read also
resets the poll cadence. The daemon fetch sends no cookies.

## Standalone Python scripts

`portability_layer.py` and `tidal_lines.py` are independent CLI scripts, not
part of the Vite build and not imported by the React app. Each is
self-documenting via a long module docstring explaining its purpose and
design rationale — read that docstring before editing either file.

- `tidal_lines.py` has **no external dependencies** and includes a synthetic
  self-test runnable with `python3 tidal_lines.py` (no args). Run it after any
  change to the analysis math — it asserts the discriminator still separates
  real tidal signal from noise/drift across six labeled cases. Pass a saved
  USGS Instantaneous-Values JSON file as an argument to analyze real data.
- `portability_layer.py` is a "skeleton" (see `CONTRACT_VERSION`) implementing
  a deterministic, recomputable form-checker over two opposing "canons." Its
  `__main__` block is a runnable demo plus a negative-control case. Keep any
  changes deterministic and re-runnable (SHA-256 fingerprints/digests are the
  whole point — don't introduce non-reproducible state).

Both scripts favor heavily-commented, prose-explained code over terse
implementations — match that style if you extend them.

## Standalone HTML / other files

- `guardian_hq_topology.html` is a static, self-styled report page (inline
  `<style>`, no build step, no JS framework). It's a point-in-time record —
  treat edits as updating a document, not a living app.
- `CRYSTLLINEUITests.swift` is a default Xcode UI-test template with no
  accompanying `.xcodeproj`/app target in this repo. It isn't wired into any
  build here; don't assume it runs or is referenced by anything else.

## Git workflow notes (observed from history)

Each feature/tool has historically been developed on its own branch and
merged via PR (`claude/<feature-name>-<hash>` → `main`), one artifact per PR
(e.g. "Add GuardianLens + tab switcher", "Add tidal-lines discriminator").
Follow that granularity: keep unrelated artifacts out of the same change set.
