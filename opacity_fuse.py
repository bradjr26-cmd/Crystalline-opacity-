#!/usr/bin/env python3
"""
OpacityFuse - crossing 4 of the pipeline: the fusion seam.
Kibler AI Solutions Corp.

One line:
  The SELECTED set from crossing 3 + the real context budget + an ordering
  strategy in -> the assembled context, a receipt on what fusion did to it,
  and a REVERBERATION that re-audits crossing 3's verdict, out.

Why it exists:
  Crossing 3 (retrieval) ends by saying "we selected these and we were sovereign
  about it." Crossing 4 is where that selected set gets fused into ONE context
  the model eats - Multi -> Single, your MSM topology in the dataflow. Two things
  happen here that crossing 3 is blind to:

    1. RE-SUPPRESSION FOR ROOM. Crossing 3 used a char_budget as a PROXY. The
       real budget is only known here, after the system prompt and query eat
       their share. Items crossing 3 counted as "delivered" can get dropped for
       room at fusion. Those are NEW capacity exclusions crossing 3 never saw.
    2. POSITIONAL SUPPRESSION. Fusion places the survivors in an order. Models
       attend strongly to the head and tail of a context and weakly to the
       middle (the "lost in the middle" effect). A selected chunk buried in the
       dead zone is functionally suppressed even though it was "sent."

  So 'selected' is not 'delivered'. This tool measures the gap.

MEASURED vs FENCED - the integrity line, held explicitly:
  MEASURED (facts about what WE did - clean receipts):
    - final order of the chunks
    - which selected items fit the real budget and which were dropped for room
    - whether atom boundaries were preserved or smeared together
  FENCED (we CANNOT see the model's attention - this is crossing 5, blind):
    - whether a buried chunk was actually ignored. The positional exposure
      curve below is a PRIOR, a labeled fence, NOT a measurement. It flags risk.
      It never asserts suppression as fact.
"""

import json
from dataclasses import dataclass, asdict
from typing import List
from opacity_retrieve import Candidate   # the pipeline composes; same atom type


@dataclass
class Placement:
    """Where a selected chunk landed, and what fusion did to it."""
    cid: str
    score: float
    position: int            # 0-indexed slot in the final assembled context, or -1 if dropped
    fit: bool                # MEASURED: did it fit the real budget
    exposure: float          # FENCED: positional attention prior, 0 (dead middle) .. 1 (head/tail)
    note: str


def _order(selected: List[Candidate], strategy: str) -> List[Candidate]:
    """Decide the sequence chunks are laid into the context.

      score    - highest relevance first (the naive default; buries the tail).
      as-given - keep the order retrieval handed us.
      sandwich - highest relevance at BOTH ends, lowest in the middle. A known
                 mitigation: put your best evidence where attention actually is.
    """
    if strategy == "as-given":
        return list(selected)
    ranked = sorted(selected, key=lambda c: c.score, reverse=True)
    if strategy == "score":
        return ranked
    if strategy == "sandwich":
        # alternate strongest to the outside-in: ends get the best, middle the worst
        out = [None] * len(ranked)
        lo, hi = 0, len(ranked) - 1
        for i, c in enumerate(ranked):
            if i % 2 == 0:
                out[lo] = c; lo += 1
            else:
                out[hi] = c; hi -= 1
        return out
    raise ValueError(f"unknown order strategy: {strategy}")


def _fit(selected: List[Candidate], token_budget: int, sep_len: int):
    """Decide which selected items fit the real budget - BEFORE any ordering.

    Room is spent on relevance, highest score first, so when something has to go
    it is the least relevant item, whatever order the context is laid out in
    afterwards. (Deciding fit in layout order would let `sandwich`, which parks the
    second-best item at the tail, drop that item and keep a weaker one.) The total
    is order-independent: every fitted item's text plus one separator between each
    adjacent pair. Returns (fitted, dropped, chars_used). `fitted` keeps the order
    crossing 3 handed us, so `as-given` still means as-given; `dropped` is in rank
    order.
    """
    keep, dropped, used = set(), [], 0
    for c in sorted(selected, key=lambda c: c.score, reverse=True):
        add = len(c.text) + (sep_len if keep else 0)
        if used + add <= token_budget:
            keep.add(id(c))
            used += add
        else:
            dropped.append(c)
    return [c for c in selected if id(c) in keep], dropped, used


def _exposure(position: int, n: int) -> float:
    """FENCED prior. U-curve: head and tail = 1.0, dead middle -> 0.0.
    This is a stand-in for where attention probably goes, NOT a measurement of
    where it went. We cannot see inside the model (crossing 5). Honest fence."""
    if n <= 1:
        return 1.0
    return round(abs(2 * position / (n - 1) - 1), 3)


def fuse(
    selected: List[Candidate],
    token_budget: int,                 # real budget in CHARS (proxy for tokens) AFTER prompt overhead
    order: str = "score",
    separator: str = "\n\n---\n\n",    # the seam laid between atoms
    dead_zone: float = 0.34,           # exposure below this = the attention dead zone
) -> dict:
    """Assemble the context and receipt what fusion did - then reverberate to 3.

    Color-phase (your scale model, applied to the fusion seam):
      red    protect - selected items dropped for room (silent re-suppression),
                       OR boundaries smeared (atoms fused into a continuum, the
                       clean_boundary work from the chunk stage destroyed).
      yellow hold    - everything fit cleanly, but high-relevance chunks landed
                       in the attention dead zone. FENCED risk, not a fact.
      green  flow    - all fit, boundaries intact, strong chunks in exposed slots.
    """
    if not selected:
        return {"error": "nothing selected - crossing 3 returned an empty set"}

    n = len(selected)
    median_score = sorted(c.score for c in selected)[n // 2]
    sep_len = len(separator)

    # first pass: decide fit by relevance (MEASURED), then lay out only the survivors
    fitted, dropped_items, used = _fit(selected, token_budget, sep_len)
    ordered = _order(fitted, order)
    n_fit = len(ordered)

    # second pass: assign positions + exposure among the FITTED items only
    placements: List[Placement] = []
    for pos, c in enumerate(ordered):
        exp = _exposure(pos, n_fit)
        note = "placed"
        if c.score >= median_score and exp < dead_zone:
            note = "FENCED RISK: high-relevance chunk in the attention dead zone"
        placements.append(Placement(c.cid, c.score, pos, True, exp, note))
    for c in dropped_items:
        placements.append(Placement(c.cid, c.score, -1, False, 0.0,
            "MEASURED: dropped for room at fusion - crossing 3 could not see this"))

    dropped = [p for p in placements if not p.fit]
    buried = [p for p in placements if p.fit and p.score >= median_score and p.exposure < dead_zone]

    # boundary integrity (MEASURED): an empty/whitespace seam smears atoms together
    smeared = len(separator.strip()) == 0

    if dropped or smeared:
        color, verdict = "red", (
            "PROTECT - " + ("selected items dropped for room (silent re-suppression). "
                            if dropped else "")
            + ("atom boundaries smeared - the chunk-stage edges were destroyed." if smeared else "")).strip()
    elif buried:
        color, verdict = "yellow", (
            "HOLD - all fit, but high-relevance chunks landed in the attention dead zone. "
            "FENCED risk: cannot confirm the model ignored them, flagging only.")
    else:
        color, verdict = "green", (
            "FLOW - all selected fit, boundaries intact, strong chunks in exposed slots.")

    # ---- the payload Brad asked for: what 4 does for 3 ----
    promised = len(selected)
    delivered = n_fit
    # Crossing 3's char_budget counts only chunk text; fusion also spends a separator
    # between each adjacent pair. Leave room for those or the re-run still over-promises.
    honest_char_budget = max(0, token_budget - sep_len * (promised - 1))
    reverberation = {
        "crossing_3_promised": promised,        # what retrieval claimed it selected
        "fusion_delivered": delivered,          # what actually made it into context (MEASURED)
        "dropped_for_room_at_fusion": len(dropped),   # NEW capacity drops 3 was blind to (MEASURED)
        "buried_in_dead_zone": len(buried),     # FENCED risk on top of that
        "verdict": (
            f"crossing 3's sovereignty was OPTIMISTIC: it counted {len(dropped)} item(s) as "
            f"delivered that fusion dropped for room. Re-run crossing 3 with "
            f"char_budget={honest_char_budget} (token_budget {token_budget} minus the "
            f"{promised - 1} separator(s) fusion adds) to make its receipt honest."
            if dropped else
            "crossing 3's selection was delivered in full at fusion; its receipt holds."),
    }

    return {
        "report": {
            "color_phase": color,
            "verdict": verdict,
            "order_strategy": order,
            "boundaries_intact": not smeared,
            "selected_in": promised,
            "fit_in_context": delivered,
            "dropped_for_room": len(dropped),
            "buried_high_relevance_FENCED": len(buried),
            "chars_used": used,
            "token_budget": token_budget,
        },
        "reverberation_to_crossing_3": reverberation,
        "placements": [asdict(p) for p in placements],
    }


def assemble(selected: List[Candidate], order: str = "score",
             separator: str = "\n\n---\n\n", token_budget: int = 10**9) -> str:
    """Produce the actual fused context string for the items that fit, in order.
    Uses the same fit decision as fuse(), so the receipt describes this string."""
    fitted, _, _ = _fit(selected, token_budget, len(separator))
    return separator.join(c.text for c in _order(fitted, order))


if __name__ == "__main__":
    # Compose the pipeline: run crossing 3, feed its KEPT set into crossing 4,
    # and watch the reverberation re-audit 3. Budget is set tight on purpose so
    # fusion has to drop one item crossing 3 thought it delivered.
    from opacity_retrieve import receipt as retrieve_receipt

    pool = [
        Candidate("a", "x" * 90, 0.91, "f0a1"),
        Candidate("b", "x" * 90, 0.88, "f0b2"),
        Candidate("c", "x" * 90, 0.86, "f0c3"),
        Candidate("d", "x" * 90, 0.84, "f0d4"),
        Candidate("e", "x" * 90, 0.40, "f0e5"),
    ]
    r3 = retrieve_receipt(pool, top_k=4)
    kept = [Candidate(v["cid"], "x" * 90, v["score"]) for v in r3["selected"]]
    print("crossing 3 selected:", [v["cid"] for v in r3["selected"]],
          "| sovereignty", r3["report"]["sovereignty_pct"])

    for strat in ("score", "sandwich"):
        print(f"\n=== fusion order = {strat} ===")
        print(json.dumps(fuse(kept, token_budget=300, order=strat)["report"], indent=2))
        print("reverb:", fuse(kept, token_budget=300, order=strat)["reverberation_to_crossing_3"]["verdict"])
