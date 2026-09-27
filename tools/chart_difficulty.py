#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Two-hand chart difficulty estimator (movement speed + tap frequency simulation).

Idea
----
Parse a chart into timed note events, then simulate two hands with a greedy
cost-based assignment:

  * fast consecutive onsets (dt < ALTERNATE_MS) alternate hands (cross-hand),
  * otherwise each note goes to the nearer hand (based on last position),
  * holds / slide travel keep a hand busy; notes during busy fall to the free hand.

From the per-hand onset series we compute:

  peakRate    max taps per second in any 1 s window (worst hand)
  peakSpeed   max button-to-button travel speed, unit-circle buttons/s (worst hand)
  density     overall note onsets per second
  busyRatio   fraction of song time a hand is held down (hold/slide travel)

Difficulty score = weighted sum (weights at top of file, calibrate freely).
The script prints the official maimai level (lv_2..lv_6) next to the estimate
so you can fit the weights on a scraped corpus later.

Supported inputs (auto-detected per file):
  * simai maidata.txt  (AstroDX dumps; taps, chords `3/4`, holds `(1){4}`,
    slides `3-6[4:3]`, touch notes weighted at 30%)
  * this project's MusicMap.json  (hand = sign of x, target = last keypoint)

Usage:
    python chart_difficulty.py <file-or-dir> ... [--json out.json]
    python chart_difficulty.py astrodx_charts            # walks dir for maidata.txt
"""

import argparse
import json
import math
import re
import sys
from pathlib import Path

# ---- score weights (fit these against official lv on a corpus) ----
W_PEAK_RATE = 2.2    # per 1 tap/s of worst-hand 1s-peak
W_PEAK_SPEED = 1.0   # per 1 buttons/s of worst-hand peak travel
W_DENSITY = 0.7      # per 1 note/s overall
W_BUSY = 2.5         # per 1.0 hold/slide busy-time ratio
SCORE_MIN, SCORE_MAX = 1.0, 15.5

ALTERNATE_MS = 150   # faster than this -> forced hand alternation
TOUCH_WEIGHT = 0.3
BUSY_TAIL_S = 0.05   # small busy tail after each tap

LV_NAMES = {1: "Basic", 2: "Advanced", 3: "Expert", 4: "Master", 5: "ReMaster", 6: "utage"}

# maimai ring: buttons clockwise 1..8, 1 top-left, 2 top-right, 3 right, ...
BTN_ANGLE = {k: math.radians(-67.5 + (k - 1) * 45) for k in range(1, 9)}


def btn_xy(k: int):
    a = BTN_ANGLE[k]
    return (math.sin(a), -math.cos(a))


# ---------------------------------------------------------------- simai parse
RE_TAP_PAREN = re.compile(r"\((\d)\)(?:\{(\d+)\})?")
RE_DIV = re.compile(r"^\{(\d+)\}$")
RE_SLIDE = re.compile(r"^(\d)[A-Za-z<>Vxqpswz-]*(\d)?\[(\d+):(\d+)\]")
RE_TOUCH = re.compile(r"^([A-Ea-e])(\d)?")
RE_NUMRUN = re.compile(r"^\d[A-Za-z0-9]*")


def parse_maidata(text: str):
    """Return (bpm, {diff_index: [ (t_sec, kind, start_btn, end_btn_or_None) ]})."""
    bpm = None
    m = re.search(r"&wholebpm=\s*([0-9.]+)", text)
    if m:
        bpm = float(m.group(1))
    # collect &inote_N= blocks (multi-line, until next '&')
    inotes = {}
    cur_key = None
    for line in text.splitlines():
        hm = re.match(r"&inote_(\d+)\s*=(.*)", line)
        if hm:
            cur_key = int(hm.group(1))
            inotes[cur_key] = [hm.group(2)]
        elif cur_key is not None and line.startswith("&"):
            cur_key = None
        elif cur_key is not None:
            inotes[cur_key].append(line)
    if bpm is None:  # fall back to first (BPM) token anywhere
        for v in inotes.values():
            m = re.search(r"\((\d{2,3})\)", ",".join(v))
            if m:
                bpm = float(m.group(1))
                break
    if not bpm:
        raise ValueError("no BPM found")
    spb = 60.0 / bpm          # seconds per beat
    bar = 4 * spb             # seconds per measure
    out = {}
    for key, lines in inotes.items():
        events = []
        body = "\n".join(lines)
        measures = body.split(",")   # comma ends a measure
        div = 4
        t0 = 0.0
        for mi, mtext in enumerate(measures):
            mt = mtext.strip().replace(" ", "")
            if not mt:
                t0 += bar
                continue
            dm = RE_DIV.match(mt)
            if dm:                       # standalone {n} = division directive
                div = max(1, int(dm.group(1)))
                t0 += bar
                continue
            slot = 0
            i = 0
            n = len(mt)
            while i < n:
                c = mt[i]
                if c == "{":            # division directive inside measure
                    dm = re.match(r"\{(\d+)\}", mt[i:])
                    if dm:
                        div = max(1, int(dm.group(1)))
                        i += dm.end()
                        continue
                    i += 1
                    continue
                if c == "(":            # tap / hold (paren form)
                    tm = RE_TAP_PAREN.match(mt, i)
                    if tm:
                        # multi-digit like (120) is a BPM directive, not a tap
                        dm2 = re.match(r"\((\d+)\)", mt[tm.start():])
                        if dm2 and len(dm2.group(1)) > 1:
                            i = tm.end()
                            continue
                        btn = int(tm.group(1))
                        dur = int(tm.group(2) or 0) * bar / div
                        events.append((t0 + slot * bar / div, "hold" if dur else "tap", btn, None, dur))
                        slot += 1
                        i = tm.end()
                        continue
                    i += 1
                    continue
                if c == "/":            # chord separator: group members share a slot
                    i += 1
                    continue
                if c in "12345678":
                    # slide first: digit + curve chars (+ end digit) + [a:b]
                    sm = re.match(r"(\d)([A-Za-z<>Vxqpswz-]*)(\d)?\[(\d+):(\d+)\]", mt[i:])
                    if sm:
                        a_, b_ = int(sm.group(4)), int(sm.group(5))
                        dur = (b_ / a_) * spb
                        s_btn = int(sm.group(1))
                        e_btn = int(sm.group(3)) if sm.group(3) else ((s_btn + 3) % 8) + 1
                        events.append((t0 + slot * bar / div, "slide", s_btn, e_btn, dur))
                        slot += 1
                        i += sm.end()
                        continue
                    run = RE_NUMRUN.match(mt, i)
                    runtxt = run.group(0) if run else c
                    rest = mt[run.end():] if run else ""
                    if rest.startswith("{"):        # bare hold 7{8}
                        hm = re.match(r"\{(\d+)\}", rest)
                        if hm:
                            dur = int(hm.group(1)) * bar / div
                            events.append((t0 + slot * bar / div, "hold", int(runtxt[0]), None, dur))
                            slot += 1
                            i = run.end() + hm.end()
                            continue
                    # plain tap (maybe with modifiers b/m/f/…)
                    events.append((t0 + slot * bar / div, "tap", int(runtxt[0]), None, 0.0))
                    slot += 1
                    i = run.end() if run else i + 1
                    continue
                if c in "ABCDEabcde":   # touch note
                    tm = RE_TOUCH.match(mt, i)
                    events.append((t0 + slot * bar / div, "touch", 0, None, 0.0))
                    slot += 1
                    i = tm.end() if tm else i + 1
                    continue
                i += 1                  # skip unknown chars
            t0 += bar
        out[key] = events
    return bpm, out


# ---------------------------------------------------------- MusicMap.json parse
def parse_musicmap(text: str):
    """Our format: notes[].endtime (ms) + keypoint target; hand from x sign.
    Coordinates normalized by half playfield width (~570px) so travel speeds
    are comparable to maimai's unit-circle buttons."""
    data = json.loads(text)
    notes = data.get("MusicData") or data.get("notes") or data
    events = []
    for nd in notes:
        kp = nd.get("keypoint") or []
        endtime = nd.get("endtime")
        if not kp or endtime is None:
            continue
        x, y = kp[-2], kp[-1]
        events.append((endtime / 1000.0, nd.get("Note", "tap"), x / 570.0, y / 570.0, 0.0))
    return {"map": events}


# ---------------------------------------------------------------- two-hand sim
class Hand:
    def __init__(self, name, start):
        self.name = name
        self.pos = start          # (x, y)
        self.free_at = 0.0
        self.onsets = []          # (t, weight)

    def cost(self, p, t):
        d = math.dist(self.pos, p)
        dt = max(t - self.free_at, 0.0)
        return d / max(dt, 0.04)  # hurry factor: distance per available second


def simulate(events):
    """events: list of (t, kind, pos, busy_until, weight). Greedy two-hand assignment."""
    events = sorted(events, key=lambda e: e[0])
    L = Hand("L", btn_xy(7))
    R = Hand("R", btn_xy(3))
    i = 0
    n = len(events)
    last_t = None
    while i < n:
        t = events[i][0]
        # gather simultaneous group
        j = i
        while j < n and events[j][0] - t < 1e-4:
            j += 1
        group = events[i:j]
        hands = [L, R]
        if len(group) == 1:
            t_, kind, p, busy, w = group[0]
            force_alt = last_t is not None and (t - last_t) * 1000 < ALTERNATE_MS
            cand = [h for h in hands if h.free_at <= t + 1e-6]
            if force_alt and len(cand) == 2:
                # alternate: pick the hand NOT used by a same-position neighbour is
                # overkill; simply pick cheaper of the two, alternating tie-break
                chosen = min(cand, key=lambda h: h.cost(p, t))
            elif cand:
                chosen = min(cand, key=lambda h: h.cost(p, t))
            else:
                chosen = min(hands, key=lambda h: h.free_at)
            chosen.pos = p
            chosen.free_at = max(busy, t + BUSY_TAIL_S)
            chosen.onsets.append((t, p))
        else:
            # chord: try both cross-hand assignments (no mutation), keep cheaper
            def try_cost(order, assign):
                c = 0.0
                for ev, h in zip(order, assign):
                    t_, kind, p, busy, w = ev
                    if h.free_at > t + 1e-6:
                        c += 10.0
                    c += h.cost(p, t)
                return c

            best_cost, best_apply = None, None
            for swap in (False, True):
                order = group if not swap else group[::-1]
                assign = [L, R] if not swap else [R, L]
                c = try_cost(order, assign)
                if best_cost is None or c < best_cost:
                    best_cost = c
                    best_apply = list(zip(order, assign))
            for h, (t_, kind, p, busy, w) in best_apply:
                h.pos = p
                h.free_at = max(busy, t + BUSY_TAIL_S)
                h.onsets.append((t, p))
        last_t = t
        i = j
    return L, R


# ------------------------------------------------------------------- metrics
def peak_rate_1s(onsets):
    if not onsets:
        return 0.0
    ts = [t for t, _ in onsets]
    best = 0.0
    j = 0
    for i in range(len(ts)):
        while ts[i] - ts[j] > 1.0 + 1e-6:
            j += 1
        best = max(best, i - j + 1)
    return float(best)


def peak_speed(onsets_with_pos):
    best = 0.0
    for a, b in zip(onsets_with_pos, onsets_with_pos[1:]):
        dt = b[0] - a[0]
        if dt < 0.05 or dt > 2.0:
            continue
        best = max(best, math.dist(a[1], b[1]) / dt)
    return best


def evaluate(events_raw, title):
    """events_raw: (t, kind, pos_or_btn, extra, dur). Returns metrics dict."""
    evs = []
    for t, kind, a, b, dur in events_raw:
        if kind in ("touch",):
            w = TOUCH_WEIGHT
            p = btn_xy(8)  # touches sit near center-ish; rough
        elif kind == "map":
            w = 1.0
            p = (a, b)
        elif isinstance(a, int) and 1 <= a <= 8:
            w = 1.0
            p = btn_xy(a)
        else:
            w = 1.0
            p = (a, b)
        busy = t + dur if dur else t
        evs.append((t, kind, p, busy, w))
    if not evs:
        return None
    L, R = simulate(evs)
    dur = max(e[0] for e in evs) - min(e[0] for e in evs)
    if dur <= 0:
        return None
    total_w = sum(e[4] for e in evs)
    peak_rate = max(peak_rate_1s(L.onsets), peak_rate_1s(R.onsets))
    ps = max(peak_speed(L.onsets), peak_speed(R.onsets))
    density = total_w / dur
    busy_untils = [e[3] for e in evs if e[3] > e[0]]
    busy_time = sum(min(e[3] - e[0], 2.0) for e in evs)
    busy_ratio = min(busy_time / (2 * dur), 1.0)
    score = (W_PEAK_RATE * peak_rate + W_PEAK_SPEED * ps + W_DENSITY * density
             + W_BUSY * busy_ratio)
    score = max(SCORE_MIN, min(SCORE_MAX, score))
    return {
        "title": title,
        "score": round(score, 2),
        "peak_rate": peak_rate,
        "peak_speed": round(ps, 2),
        "density": round(density, 2),
        "busy_ratio": round(busy_ratio, 3),
        "notes": len(evs),
        "duration_s": round(dur, 1),
    }


# ---------------------------------------------------------------------- main
def eval_maidata_file(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    title_m = re.search(r"&title=(.*)", text)
    title = title_m.group(1).strip() if title_m else path.parent.name
    bpm, diff_events = parse_maidata(text)
    rows = []
    for key in sorted(diff_events):
        events = diff_events[key]
        if not events:
            continue
        r = evaluate(events, title)
        if r:
            r["diff"] = LV_NAMES.get(key, f"inote_{key}")
            r["official_lv"] = _official_lv(text, key)
            rows.append(r)
    return rows


def _official_lv(text, key):
    m = re.search(rf"&lv_{key}\s*=\s*([0-9.]+)", text)
    return float(m.group(1)) if m else None


def eval_musicmap_file(path: Path):
    parsed = parse_musicmap(path.read_text(encoding="utf-8", errors="replace"))
    r = evaluate([(t, "map", a, b, d) for t, _, a, b, d in parsed["map"]], path.stem)
    return [r] if r else []


def main() -> int:
    ap = argparse.ArgumentParser(description="two-hand chart difficulty estimator")
    ap.add_argument("paths", nargs="+", help="maidata.txt files / dirs / MusicMap.json")
    ap.add_argument("--json", dest="json_out", help="also write results as JSON lines")
    args = ap.parse_args()

    files = []
    for p in args.paths:
        pp = Path(p)
        if pp.is_dir():
            files += sorted(pp.rglob("maidata.txt"))
            files += sorted(pp.glob("MusicMap*.json"))
        else:
            files.append(pp)
    if not files:
        print("no chart files found", file=sys.stderr)
        return 1

    all_rows = []
    for f in files:
        try:
            if f.suffix == ".json":
                rows = eval_musicmap_file(f)
            else:
                rows = eval_maidata_file(f)
        except Exception as e:  # noqa: BLE001
            print(f"[skip] {f}: {e}", file=sys.stderr)
            continue
        all_rows += rows
        for r in rows:
            off = f"{r['official_lv']:.1f}" if r.get("official_lv") is not None else "  - "
            print(f"{r['title'][:24]:<24} {r.get('diff', '--')[:9]:<9} "
                  f"est={r['score']:>5.2f} official={off:>5} "
                  f"(taps/s={r['peak_rate']:.0f} move={r['peak_speed']:.1f} "
                  f"dens={r['density']:.1f} hold={r['busy_ratio']:.2f})")
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            for r in all_rows:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"-> {args.json_out} ({len(all_rows)} rows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
