#!/usr/bin/env python3
"""
co_harness.py - score any read against a known answer key. Headless, stdlib only.
Kibler AI Solutions Corp.

Same four channels and 200 ms tick as HunterMode. The harness plants events, logs
them as an answer key (hashed, so a run is a receipt), feeds samples to each read
tick by tick, and scores every alarm against the key: hits, misses, false alarms, lag.

EVENTS (the answer key)
  mean_step   the average shifts               (HunterMode's original bump)
  var_up      jitter widens, average unchanged
  var_down    jitter narrows, average unchanged
  corr_onset  jitter picks up memory (lag-1 correlation); spread and average unchanged

READS
  mean        HunterMode's detector: 10-sample average vs |0.35|. The baseline to beat.
  control     textbook rolling variance + lag-1 autocorrelation over 10 s, calibrated
              on the event-free warm-up. A positive control that proves texture events
              are findable at all. It is NOT CrystallineOpacity.
  your read   --read path/file.py:ClassName   (Python class, contract below)
              --external "command args"        (any executable, any language, e.g. a
                                                Swift binary; JSON lines on stdin/stdout)

PLUG-IN CONTRACT
  Python:
      class MyRead:
          name = "crystalline_opacity"
          def __init__(self, channel_ids): ...
          def step(self, tick, samples):         # samples = {"CH-A": 1.02, ...}
              return {"CH-A": False, ...}        # True = alarm on that channel
          def baseline(self):                    # optional: learned resting texture
              return {"CH-A": {"variance": v, "lag1": r}, ...}
  External, lockstep, one line each way per tick:
      in : {"tick": 41, "samples": {"CH-A": 1.02, ...}}
      out: {"CH-A": false, "CH-B": true, ...}
      last line in: {"tick": -1, "done": true}  -> reply {"baseline": {...}} or {}

LIVING BASELINE
  The true resting texture is known exactly here (variance below, lag-1 = 0), so a read
  that reports baseline() is graded on it too.

USAGE
  python3 co_harness.py                          # self-test: mean vs control, 60 sim-min
  python3 co_harness.py --noise gaussian         # unbounded noise, same spread
  python3 co_harness.py --read my_read.py:MyRead
  python3 co_harness.py --external "./CrystallineOpacityCLI"
  python3 co_harness.py --minutes 240 --seed 7 --json report.json --key key.jsonl
"""

import argparse
import hashlib
import importlib.util
import json
import math
import random
import subprocess
import sys
from collections import deque

VERSION = "co_harness 1.0"

# ---- signal model (HunterMode, unchanged) -----------------------------------
TICK_MS = 200
CHANNELS = ["CH-A", "CH-B", "CH-C", "CH-D"]
LABELS = {"CH-A": "ALPHA", "CH-B": "BETA", "CH-C": "GAMMA", "CH-D": "DELTA"}
BASELINE = 1.0
HALF_WIDTH = 0.35                    # raw noise 0.65..1.35
THRESHOLD = 0.35
BUFFER = 10
TRUE_VAR = HALF_WIDTH ** 2 / 3.0     # resting variance for both noise models (0.04083)

# ---- answer-key schedule ----------------------------------------------------
WARMUP_TICKS = 300                   # first 60 s event-free; reads may calibrate here
GRACE_TICKS = 75                     # alarms up to 15 s after an event ends still count for it
EVENT_P = 0.002                      # per channel per tick
EVENT_TYPES = ("mean_step", "var_up", "var_down", "corr_onset")


class Event:
    __slots__ = ("id", "ch", "type", "param", "start", "end")

    def __init__(self, id_, ch, type_, param, start, end):
        self.id, self.ch, self.type, self.param = id_, ch, type_, param
        self.start, self.end = start, end

    def as_dict(self):
        return {"id": self.id, "ch": self.ch, "type": self.type,
                "param": round(self.param, 4), "start": self.start, "end": self.end}


def make_event(rng, ch, k, n):
    t = rng.choice(EVENT_TYPES)
    if t == "mean_step":
        p = rng.uniform(0.2, 0.8) * rng.choice((-1, 1))     # signed shift of the average
        dur = rng.randint(15, 40)
    elif t == "var_up":
        p = rng.uniform(1.5, 2.5)                           # jitter scale factor
        dur = rng.randint(60, 150)
    elif t == "var_down":
        p = rng.uniform(0.2, 0.6)
        dur = rng.randint(60, 150)
    else:
        p = rng.uniform(0.6, 0.95)                          # lag-1 memory (AR coefficient)
        dur = rng.randint(60, 150)
    return Event(f"E{n:04d}", ch, t, p, k, k + dur)


def jitter(rng, noise):
    if noise == "uniform":
        return rng.uniform(-HALF_WIDTH, HALF_WIDTH)
    return rng.gauss(0.0, math.sqrt(TRUE_VAR))


# ---- reads ------------------------------------------------------------------
def _var(xs):
    n = len(xs)
    m = sum(xs) / n
    return sum((x - m) ** 2 for x in xs) / (n - 1)


def _lag1(xs):
    xs = list(xs)
    n = len(xs)
    m = sum(xs) / n
    den = sum((x - m) ** 2 for x in xs)
    if den <= 0:
        return 0.0
    return sum((xs[i] - m) * (xs[i - 1] - m) for i in range(1, n)) / den


class MeanRead:
    """HunterMode's detector, exactly: 10-sample average vs a fixed line."""
    name = "mean (HunterMode)"

    def __init__(self, ids):
        self.buf = {c: deque(maxlen=BUFFER) for c in ids}

    def step(self, tick, samples):
        out = {}
        for c, x in samples.items():
            b = self.buf[c]
            b.append(x)
            out[c] = abs(sum(b) / len(b) - BASELINE) > THRESHOLD
        return out


class ControlRead:
    """Textbook texture read: rolling variance ratio and lag-1 autocorrelation over a
    10 s window, against variance learned on the event-free warm-up. A positive
    control only - proof the texture events are findable. Not CrystallineOpacity."""
    name = "control (textbook texture)"
    W = 50
    VAR_HI, VAR_LO, CORR = 1.6, 0.55, 0.5

    def __init__(self, ids):
        self.win = {c: deque(maxlen=self.W) for c in ids}
        self.cal = {c: [] for c in ids}
        self.ref = {}

    def step(self, tick, samples):
        out = {}
        for c, x in samples.items():
            w = self.win[c]
            w.append(x)
            if tick <= WARMUP_TICKS:
                self.cal[c].append(x)
                out[c] = False
                continue
            if c not in self.ref:
                self.ref[c] = _var(self.cal[c])
            ratio = _var(w) / self.ref[c]
            out[c] = ratio > self.VAR_HI or ratio < self.VAR_LO or abs(_lag1(w)) > self.CORR
        return out

    def baseline(self):
        return {c: {"variance": self.ref.get(c, _var(v)), "lag1": _lag1(v)}
                for c, v in self.cal.items()}


class ExternalRead:
    """Any executable, any language. Lockstep JSON lines over stdin/stdout."""

    def __init__(self, cmd, ids):
        self.name = f"external: {cmd}"
        self.p = subprocess.Popen(cmd, shell=True, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, text=True, bufsize=1)

    def _ask(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError(f"{self.name} closed its output")
        return json.loads(line)

    def step(self, tick, samples):
        d = self._ask({"tick": tick, "samples": samples})
        return {c: bool(d.get(c, False)) for c in samples}

    def baseline(self):
        try:
            return self._ask({"tick": -1, "done": True}).get("baseline")
        except Exception:
            return None
        finally:
            try:
                self.p.stdin.close()
                self.p.wait(timeout=5)
            except Exception:
                self.p.kill()


def load_python_read(spec, ids):
    path, cls = spec.rsplit(":", 1)
    s = importlib.util.spec_from_file_location("user_read", path)
    mod = importlib.util.module_from_spec(s)
    s.loader.exec_module(mod)
    read = getattr(mod, cls)(ids)
    if not hasattr(read, "name"):
        read.name = cls
    return read


# ---- run + score ------------------------------------------------------------
def run(minutes=60.0, seed=1, noise="uniform", reads=None):
    rng = random.Random(seed)
    ticks = int(minutes * 60_000 / TICK_MS)
    reads = reads or [MeanRead(CHANNELS), ControlRead(CHANNELS)]
    active = {c: None for c in CHANNELS}
    prev_noise = {c: 0.0 for c in CHANNELS}
    next_ok = {c: 0 for c in CHANNELS}
    last_ev = {c: None for c in CHANNELS}
    events = []
    st = {i: {"prev": {c: False for c in CHANNELS}, "hit": {}, "false": 0}
          for i in range(len(reads))}

    for k in range(1, ticks + 1):
        samples = {}
        for c in CHANNELS:
            ev = active[c]
            if ev and k >= ev.end:
                active[c] = ev = None
            if ev is None and k > WARMUP_TICKS and k >= next_ok[c] and rng.random() < EVENT_P:
                ev = make_event(rng, c, k, len(events))
                events.append(ev)
                active[c] = last_ev[c] = ev
                next_ok[c] = ev.end + GRACE_TICKS + 1     # scoring windows never overlap
            e = jitter(rng, noise)
            shift = 0.0
            if ev is None:
                d = e
            elif ev.type == "mean_step":
                d, shift = e, ev.param
            elif ev.type in ("var_up", "var_down"):
                d = e * ev.param
            else:
                rho = ev.param
                d = rho * prev_noise[c] + math.sqrt(1 - rho * rho) * e
            prev_noise[c] = d
            samples[c] = round(BASELINE + d + shift, 6)

        for i, r in enumerate(reads):
            flags = r.step(k, dict(samples))
            s = st[i]
            for c in CHANNELS:
                f = bool(flags.get(c, False))
                if f and not s["prev"][c]:                      # rising edge
                    ev = last_ev[c]
                    if ev and ev.start <= k < ev.end + GRACE_TICKS:
                        s["hit"].setdefault(ev.id, k - ev.start)  # first edge = the catch
                    else:
                        s["false"] += 1
                s["prev"][c] = f

    scored = [e for e in events if e.end + GRACE_TICKS <= ticks]
    key = [e.as_dict() for e in events]
    digest = hashlib.sha256(json.dumps(
        {"version": VERSION, "seed": seed, "noise": noise, "minutes": minutes, "events": key},
        sort_keys=True).encode()).hexdigest()

    report = {"version": VERSION, "minutes": minutes, "seed": seed, "noise": noise,
              "tick_ms": TICK_MS, "events_total": len(events), "events_scored": len(scored),
              "answer_key_sha256": digest, "reads": []}
    for i, r in enumerate(reads):
        s = st[i]
        by_type = {}
        for t in EVENT_TYPES:
            es = [e for e in scored if e.type == t]
            hits = [s["hit"][e.id] for e in es if e.id in s["hit"]]
            by_type[t] = {"n": len(es), "hits": len(hits), "misses": len(es) - len(hits),
                          "hit_rate": round(len(hits) / len(es), 3) if es else None,
                          "mean_lag_s": round(sum(hits) / len(hits) * TICK_MS / 1000, 2) if hits else None}
        entry = {"name": r.name, "by_type": by_type, "false_alarms": s["false"],
                 "false_alarms_per_hour": round(s["false"] / (minutes / 60.0), 2)}
        if hasattr(r, "baseline"):
            b = r.baseline()
            if b:
                entry["baseline"] = {
                    c: {"variance": round(v["variance"], 5),
                        "variance_err_pct": round(100 * (v["variance"] - TRUE_VAR) / TRUE_VAR, 1),
                        "lag1": round(v["lag1"], 3)}
                    for c, v in b.items()}
        report["reads"].append(entry)
    return report, key


def format_report(rep):
    lines = [f"{rep['version']} · {rep['minutes']:g} sim-min · seed {rep['seed']} · noise {rep['noise']}",
             f"answer key: {rep['events_total']} events, {rep['events_scored']} scored "
             f"(sha256 {rep['answer_key_sha256'][:16]}…)", ""]
    for r in rep["reads"]:
        lines.append(f"read: {r['name']}")
        lines.append(f"  {'event':<11}{'n':>4}{'hit':>5}{'miss':>6}{'rate':>7}{'lag':>8}")
        for t, v in r["by_type"].items():
            rate = f"{v['hit_rate'] * 100:.0f}%" if v["hit_rate"] is not None else "—"
            lag = f"{v['mean_lag_s']:.1f}s" if v["mean_lag_s"] is not None else "—"
            lines.append(f"  {t:<11}{v['n']:>4}{v['hits']:>5}{v['misses']:>6}{rate:>7}{lag:>8}")
        lines.append(f"  false alarms: {r['false_alarms']} ({r['false_alarms_per_hour']}/h)")
        if "baseline" in r:
            vs = [v["variance_err_pct"] for v in r["baseline"].values()]
            ls = [v["lag1"] for v in r["baseline"].values()]
            lines.append(f"  living baseline: variance err {min(vs):+.1f}%..{max(vs):+.1f}% "
                         f"(true {TRUE_VAR:.4f}), lag1 {min(ls):+.3f}..{max(ls):+.3f} (true 0)")
        lines.append("")
    return "\n".join(lines)


def self_test(minutes, seed):
    print("co_harness self-test - auditing the harness before trusting a score\n")
    ok = True
    for noise in ("uniform", "gaussian"):
        rep, key = run(minutes, seed, noise)
        print(format_report(rep))
        mean, ctrl = rep["reads"]
        checks = [
            ("mean read is structurally blind to narrowing jitter",
             mean["by_type"]["var_down"]["hits"] == 0),
            ("mean read still catches its own kind of event (mean_step >= 80%)",
             (mean["by_type"]["mean_step"]["hit_rate"] or 0) >= 0.8),
            ("control finds every texture type (>= 80% each)",
             all((ctrl["by_type"][t]["hit_rate"] or 0) >= 0.8 for t in ("var_up", "var_down", "corr_onset"))),
            ("every event lands in exactly one bucket (hits + misses = n)",
             all(v["hits"] + v["misses"] == v["n"] for r in rep["reads"] for v in r["by_type"].values())),
            ("same seed, same answer key (replayable receipt)",
             run(minutes, seed, noise)[0]["answer_key_sha256"] == rep["answer_key_sha256"]),
        ]
        for label, passed in checks:
            ok &= passed
            print(f"[{'PASS' if passed else 'FAIL'}] {noise}: {label}")
        print()
    print("ALL PASS - the harness is sound; plug a read in." if ok
          else "FAIL - do not trust scores until this passes.")
    return ok


def main(argv=None):
    ap = argparse.ArgumentParser(description="Score reads against a known answer key.")
    ap.add_argument("--minutes", type=float, default=60.0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--noise", choices=("uniform", "gaussian"), default="uniform")
    ap.add_argument("--read", action="append", default=[], help="path/file.py:ClassName")
    ap.add_argument("--external", action="append", default=[], help="command speaking the JSON-lines contract")
    ap.add_argument("--no-control", action="store_true", help="score only the mean baseline and your read(s)")
    ap.add_argument("--json", help="write the full report here")
    ap.add_argument("--key", help="write the answer key here (JSON lines)")
    a = ap.parse_args(argv)

    if not a.read and not a.external and not a.json and not a.key:
        return 0 if self_test(a.minutes, a.seed) else 1

    reads = [MeanRead(CHANNELS)] + ([] if a.no_control else [ControlRead(CHANNELS)])
    reads += [load_python_read(s, CHANNELS) for s in a.read]
    reads += [ExternalRead(cmd, CHANNELS) for cmd in a.external]
    rep, key = run(a.minutes, a.seed, a.noise, reads)
    print(format_report(rep))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(rep, f, indent=2)
    if a.key:
        with open(a.key, "w") as f:
            for e in key:
                f.write(json.dumps(e) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
