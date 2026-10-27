#!/usr/bin/env python3
"""
OpacityRetrieve - the gradient-receipt twin of OpacityChunk.
Kibler AI Solutions Corp.

One line:
  Candidate chunks + scores + a selection rule in -> the SELECTED set, the
  REJECTED set, and a receipt on the CUT ITSELF, out.

Why it exists:
  OpacityChunk put a receipt on atoms - things with edges. Retrieval has no
  edges. Embedding dissolves chunks into a continuous field; cosine similarity
  is a gradient, not a boundary. So the atomic receipt (clean_boundary T/F) is
  a category error here. You cannot measure fog with a ruler.

  This tool changes phase with the data. Instead of "did we cut cleanly" it
  asks "what is the SHAPE of the field at the cut." And it puts the receipt on
  the NEGATIVE SPACE - the set you declined to send - because that is where
  retrieval lies to you silently.

Two faces, by design:
  transparency face - what got selected, its score, why it cleared.
  opacity face      - what got EXCLUDED, the boundary it failed, and whether
                      that exclusion was a RULE FIRING (clean, on purpose) or
                      CAPACITY EXHAUSTED (a silent drop wearing the costume of
                      a decision).

This tool is embedder-agnostic. Scores come from whatever model you already
use; OpacityRetrieve never touches the field math. It only audits the cut.
"""

import json
from dataclasses import dataclass, asdict
from typing import List, Optional


@dataclass
class Candidate:
    """One thing the retriever considered. Score is from YOUR embedder."""
    cid: str                       # stable id (reuse OpacityChunk fingerprint if you have it)
    text: str                      # the candidate content
    score: float                   # relevance score, higher = closer. Any scale.
    fingerprint: str = ""          # optional carry-over from the chunk stage


@dataclass
class Verdict:
    """The receipt line for a single candidate: kept or dropped, and WHY."""
    cid: str
    score: float
    kept: bool
    reason: str                    # human-readable: which boundary decided this
    exclusion_kind: str            # 'kept' | 'rule' | 'capacity'


def select(
    candidates: List[Candidate],
    min_score: Optional[float] = None,   # rule: drop anything below this (or None)
    top_k: Optional[int] = None,         # rule: keep at most this many (or None)
    char_budget: Optional[int] = None,   # CAPACITY: total chars the context can hold
) -> List[Verdict]:
    """Apply the selection rules in a fixed, auditable order and record WHY.

    Order matters and is fixed on purpose so the receipt is reproducible:
      1. min_score   - a RULE. A named threshold fired.
      2. top_k       - a RULE. A named cap fired.
      3. char_budget - CAPACITY. We ran out of room. This is the dangerous one,
                       because a budget drop looks identical to a decision from
                       the outside. We mark it differently so the receipt tells
                       the truth: this item wasn't judged irrelevant, we just
                       had no space. That is inertia wearing the costume of inert.
    """
    ordered = sorted(candidates, key=lambda c: c.score, reverse=True)
    verdicts: List[Verdict] = []
    kept_chars = 0
    kept_count = 0

    for c in ordered:
        # 1. threshold rule
        if min_score is not None and c.score < min_score:
            verdicts.append(Verdict(c.cid, c.score, False,
                f"below min_score {min_score}", "rule"))
            continue
        # 2. top_k rule
        if top_k is not None and kept_count >= top_k:
            verdicts.append(Verdict(c.cid, c.score, False,
                f"beyond top_k {top_k}", "rule"))
            continue
        # 3. capacity (the silent killer, made loud)
        if char_budget is not None and kept_chars + len(c.text) > char_budget:
            verdicts.append(Verdict(c.cid, c.score, False,
                "budget exhausted - NOT judged irrelevant, no room", "capacity"))
            continue
        # survived every boundary -> kept
        verdicts.append(Verdict(c.cid, c.score, True,
            "cleared all boundaries", "kept"))
        kept_chars += len(c.text)
        kept_count += 1

    return verdicts


def _cut_shape(verdicts: List[Verdict]):
    """Measure the SHAPE of the field at the cut - the gradient receipt.

    The cut sits between the lowest-scoring KEPT item and the highest-scoring
    DROPPED item. We report two things about that seam:

      gap          - score(last kept) - score(first dropped). A big gap means the
                     threshold sliced through a CLIFF: a real gap between in and
                     out. A tiny gap means it sliced through a PLATEAU: a dozen
                     items sat a hair apart and half made it for no principled
                     reason.
      cliff_ratio  - the gap divided by the field's average step between adjacent
                     ranked items. Unitless, so it reads the same on any scale your
                     embedder uses. A field of tied scores has no steps at all; that
                     is the purest plateau, so it reads 0, never "no reading".
    """
    kept = [v for v in verdicts if v.kept]
    dropped = [v for v in verdicts if not v.kept]
    if not kept or not dropped:
        return {"gap": None, "pileup": 0, "note": "no cut - all kept or all dropped"}

    last_kept = min(v.score for v in kept)
    first_dropped = max(v.score for v in dropped)
    gap = round(last_kept - first_dropped, 4)

    # Scale-free reading: compare the gap AT THE CUT to the average step
    # between adjacent ranked items. A cliff is a gap much larger than the
    # field's local spacing; a plateau is a gap indistinguishable from any
    # other step. The ratio is unitless, so it survives whatever scale your
    # embedder scores on - this is the fix for measuring fog with a ruler.
    scores = sorted((v.score for v in verdicts), reverse=True)
    steps = [scores[i] - scores[i + 1] for i in range(len(scores) - 1)]
    avg_step = sum(steps) / len(steps) if steps else 0.0
    # No steps means every score is tied (so the gap is 0 too): a pure plateau.
    cliff_ratio = round(gap / avg_step, 2) if avg_step > 0 else 0.0

    return {"gap": gap, "avg_step": round(avg_step, 4), "cliff_ratio": cliff_ratio,
            "last_kept": last_kept, "first_dropped": first_dropped}


def receipt(
    candidates: List[Candidate],
    min_score: Optional[float] = None,
    top_k: Optional[int] = None,
    char_budget: Optional[int] = None,
) -> dict:
    """The full retrieval receipt: two faces + a gradient reading of the cut.

    The headline trust number is SOVEREIGNTY: of everything excluded, what
    fraction was excluded by a NAMED RULE versus dropped for CAPACITY.
      high = your retrieval is sovereign over its own boundaries.
      low  = your context window is silently editing your evidence and calling
             it a choice.

    Color-phase verdict (your scale-invariant model, applied to the cut):
      green  flow    - clean gap, every exclusion rule-fired. The cut found a seam.
      yellow hold    - dense pileup at the cut. The cut INVENTED a seam in a plateau.
      red    protect - capacity drops or an inverted cut. Suppression you can't
                       fully account for - silent editing of the evidence.
    """
    if not candidates:
        return {"error": "no candidates - did retrieval return empty?"}

    verdicts = select(candidates, min_score, top_k, char_budget)
    kept = [v for v in verdicts if v.kept]
    excluded = [v for v in verdicts if not v.kept]
    rule_excl = [v for v in excluded if v.exclusion_kind == "rule"]
    cap_excl = [v for v in excluded if v.exclusion_kind == "capacity"]

    shape = _cut_shape(verdicts)

    # sovereignty over boundaries
    if excluded:
        sovereignty = round(100 * len(rule_excl) / len(excluded), 1)
    else:
        sovereignty = 100.0

    # duplicate detection carried across the phase change
    fps = [c.fingerprint for c in candidates if c.fingerprint]
    duplicates = len(fps) - len(set(fps)) if fps else 0

    # color-phase from the shape of the cut.
    # CLIFF_THRESHOLD: how many times the local spacing the cut-gap must exceed
    # to count as a real seam rather than an arbitrary slice through a gradient.
    CLIFF_THRESHOLD = 2.0
    ratio = shape.get("cliff_ratio")
    inverted = shape.get("gap") is not None and shape["gap"] < 0
    if cap_excl or inverted:
        color = "red"      # protect - unaccountable suppression / silent edit
        verdict = "PROTECT - capacity drops or inverted cut. Evidence may be silently edited."
    elif shape.get("gap") is None and kept:
        color = "green"    # flow - nothing withheld, so there is no seam to judge
        verdict = "FLOW - nothing was excluded; there is no cut to audit."
    elif shape.get("gap") is None:
        color = "yellow"   # hold - an empty context is not a seam either
        verdict = "HOLD - nothing was selected; every candidate failed a rule. Check the rule before sending an empty context."
    elif ratio < CLIFF_THRESHOLD:
        color = "yellow"   # hold - the cut sliced a plateau, not a seam
        verdict = "HOLD - cut-gap is within local spacing. The threshold invented a seam in a plateau."
    else:
        color = "green"    # flow - real cliff at the cut, rule-fired only
        verdict = "FLOW - the cut found a real seam (gap >> local spacing), every exclusion rule-fired."

    return {
        "report": {
            "color_phase": color,
            "verdict": verdict,
            "sovereignty_pct": sovereignty,       # headline trust number
            "considered": len(candidates),
            "selected": len(kept),
            "excluded_by_rule": len(rule_excl),
            "excluded_by_capacity": len(cap_excl),  # the silent failures, made loud
            "duplicate_candidates": duplicates,
            "cut_shape": shape,                    # the gradient receipt
        },
        # transparency face: what we SENT
        "selected": [asdict(v) for v in kept],
        # opacity face: what we WITHHELD, and whether it was principled
        "rejected": [asdict(v) for v in excluded],
    }


if __name__ == "__main__":
    # Built-in demo. Scores stand in for cosine sims from a real embedder.
    # This set is rigged to show a CLEAN cut (cliff) vs what a plateau/budget
    # case would flag - swap the numbers to feel each color fire.
    demo = [
        Candidate("a", "Guardian is a constitutional substrate.", 0.91, "f0a1"),
        Candidate("b", "It does not override the human operator.", 0.88, "f0b2"),
        Candidate("c", "The Ollie Ledger gates GO HOLD STOP decisions.", 0.86, "f0c3"),
        Candidate("d", "Mycelium routes signal along gradient paths.", 0.61, "f0d4"),
        Candidate("e", "Unrelated note about coin grading.", 0.42, "f0e5"),
        Candidate("f", "Another off-topic fragment entirely.", 0.39, "f0f6"),
    ]
    # top_k=3 with a real gap below it -> should read FLOW (green).
    print(json.dumps(receipt(demo, top_k=3), indent=2))
