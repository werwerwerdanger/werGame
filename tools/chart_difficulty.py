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
    slides `3-6[4:3]`; touch notes excluded — guidance only)
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
W_READ = 0.7         # per 1 unit of read_load (density + hold span + star path)
W_BUSY = 2.5         # per 1.0 hold/slide busy-time ratio
SCORE_MIN, SCORE_MAX = 1.0, 100.0  # raw scale — report linearly fits to official lv

ALTERNATE_MS = 150   # faster than this -> forced hand alternation
TOUCH_WEIGHT = 0.0   # unused: touches are excluded from difficulty entirely
BUSY_TAIL_S = 0.05   # small busy tail after each tap
SLIDE_BUSY_S = 0.10  # stars can be left alone: hand is only busy a fixed moment
CROSS_PENALTY = 2.0  # cost penalty for reaching across the center (交叉手)

LV_NAMES = {1: "Basic", 2: "Advanced", 3: "Expert", 4: "Master", 5: "ReMaster", 6: "utage"}

# maimai ring: buttons clockwise 1..8, 1 top-left of center, 2 top-right of
# center (they straddle the top), 3/4 right, 5/6 bottom, 7/8 left
BTN_ANGLE = {k: math.radians(-22.5 + (k - 1) * 45) for k in range(1, 9)}


def btn_xy(k: int):
    a = BTN_ANGLE[k]
    return (math.sin(a), -math.cos(a))


# ---------------------------------------------------------------- simai parse
RE_BPM_DIR = re.compile(r"\((\d+(?:\.\d+)?)\)")   # (150) BPM directive
RE_DIV_DIR = re.compile(r"\{(\d+(?:\.\d+)?)\}")   # {16} division directive
RE_HS = re.compile(r"<(\d+(?:\.\d+)?)>")          # <2.0> hi-speed marker
RE_SLIDE_TAIL = re.compile(r"\[(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)\]$")
RE_SLIDE_TAIL_HASH = re.compile(r"\[(\d*\.?\d+)##(\d*\.?\d+)\]$")
RE_SLIDE_HEAD = re.compile(r"^(\d)([A-Za-z<>Vxqpswz?~-])(\d?)$")
RE_HOLD = re.compile(r"^(\d)[a-z]*\{(\d+)\}$")    # 7{8} hold, 8 slots
RE_TOUCH = re.compile(r"^([A-Ea-e])(\d?)[a-z]*$") # A3 / C / Cf touch note
RE_WIFI = re.compile(r"^(\d)w")                   # 8w5-2/7/5/3/1[8:1]


def parse_maidata(text: str):
    """Return (bpm, {diff_index: [ (t_sec, kind, start_btn, end_btn_or_None, dur[, curve]) ]}).

    Timing model follows the arcade simai parser (maimai-chart-engine):
      * EVERY comma is one time slot, advancing 4/div beats — commas are the
        rhythmic grid, NOT measure separators; empty slots just advance time.
      * {div} / (bpm) / <hs> directives take effect in place and consume no
        slot; measure boundaries emerge from cumulative beats.
      * slide [n:m] duration = m/n of one measure (NOT m/n beats).
      * simultaneous notes share a slot, joined by `/`; adjacent digits in a
        group are a chord (all taps at the same instant).
    """
    bpm = None
    m = re.search(r"&(?:whole)?bpm\s*=\s*([0-9.]+)", text)
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
    if bpm is None:  # fall back to first (bpm) directive anywhere
        for v in inotes.values():
            m = RE_BPM_DIR.search(",".join(v))
            if m:
                bpm = float(m.group(1))
                break
    if not bpm:
        raise ValueError("no BPM found")
    out = {}
    for key, lines in inotes.items():
        body = "\n".join(lines)
        body = re.sub(r"//[^\n]*", "", body)  # strip simai comments
        events = []
        div = 4.0
        bcur = bpm
        ms = 0.0
        for chunk in body.split(","):
            for dm in RE_BPM_DIR.finditer(chunk):
                bcur = float(dm.group(1))
            for dm in RE_DIV_DIR.finditer(chunk):
                div = max(1.0, float(dm.group(1)))
            # strip directives so their digits never become taps
            c = re.sub(r"\([^)]*\)|\{[^}]*\}", "", chunk)
            c = RE_HS.sub("", c).strip()
            spb = 60.0 / bcur
            if c:
                t = ms
                if RE_WIFI.match(c) and RE_SLIDE_TAIL.search(c):
                    # wifi: one star fanning out; treat as a single wide slide
                    tail = RE_SLIDE_TAIL.search(c)
                    a_, b_ = tail.groups()
                    dur = (float(b_) / float(a_)) * 4.0 * spb
                    s_btn = int(c[0])
                    nums = re.findall(r"\d", c[: tail.start()])
                    e_btn = int(nums[-1]) if nums else ((s_btn + 3) % 8) + 1
                    events.append((t, "slide", s_btn, e_btn, dur, "w"))
                else:
                    for g in c.split("/"):
                        g = g.strip()
                        if g:
                            _emit_group(g, t, div, spb, events)
            ms += (4.0 / div) * spb
        out[key] = events
    return bpm, out


def _match_slide_head(head: str):
    """Return (start_btn, curve, end_btn_or_None) for a slide head, else None."""
    hm = RE_SLIDE_HEAD.match(head)
    if hm:
        return (int(hm.group(1)), hm.group(2),
                int(hm.group(3)) if hm.group(3) else None)
    wm = re.match(r"^(\d)\??w(\d)$", head)  # 4w8 / 4?w8 wifi
    if wm:
        return int(wm.group(1)), "w", int(wm.group(2))
    return None


def _emit_group(g: str, t: float, div: float, spb: float, events: list):
    """Emit event tuples for one simultaneous group at time t."""
    # utage tails like [0.2##0.8]: beat positions start##end -> dur = end-start
    um = RE_SLIDE_TAIL_HASH.search(g)
    if um:
        hm = _match_slide_head(g[: um.start()])
        if hm:
            s_btn, curve, e_btn = hm
            dur = max(float(um.group(2)) - float(um.group(1)), 0.05) * spb
            if e_btn is None:
                e_btn = ((s_btn + 3) % 8) + 1
            if curve == "h":
                events.append((t, "hold", s_btn, None, dur))
            else:
                events.append((t, "slide", s_btn, e_btn, dur,
                               curve if curve != "?" else "-"))
            return
    sm = RE_SLIDE_TAIL.search(g)
    if sm:
        hm = _match_slide_head(g[: sm.start()])
        if hm:
            s_btn, curve, e_btn = hm
            a_, b_ = float(sm.group(1)), float(sm.group(2))
            dur = (b_ / a_) * 4.0 * spb  # [n:m] = m/n of a measure
            # 'h' is the hold marker (2h[1:1] = hold one measure), not a curve
            if curve == "h":
                events.append((t, "hold", s_btn, None, dur))
                return
            if e_btn is None:
                e_btn = ((s_btn + 3) % 8) + 1
            events.append((t, "slide", s_btn, e_btn, dur,
                           curve if curve != "?" else "-"))
            return
    hm = RE_HOLD.match(g)
    if hm:
        dur = int(hm.group(2)) * (4.0 / div) * spb
        events.append((t, "hold", int(hm.group(1)), None, dur))
        return
    if re.match(r"^\d[a-z]?$", g) and g.endswith("h"):
        # bare hold without duration: give it one slot
        events.append((t, "hold", int(g[0]), None, (4.0 / div) * spb))
        return
    if not g[0].isdigit() and RE_TOUCH.match(g):
        events.append((t, "touch", 0, None, 0.0))
        return
    # taps: adjacent digits = chord (same instant); letters are modifiers
    for ch in g:
        if ch in "12345678":
            events.append((t, "tap", int(ch), None, 0.0))


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
# approximate path-length multiplier by slide curve shape (vs straight chord)
CURVE_MULT = {"-": 1.0, "x": 1.5, "V": 1.4, "p": 1.6, "q": 1.6, "<": 1.6,
              ">": 1.6, "s": 2.0, "z": 1.8, "w": 1.5, "h": 1.2, "E": 1.3}


class Hand:
    def __init__(self, name, start, home_sign=0):
        self.name = name
        self.pos = start          # (x, y)
        self.free_at = 0.0
        self.home_sign = home_sign  # -1 = left side, +1 = right side
        self.onsets = []          # (t, pos, is_tap) — slides add an arrival point
        self.speed_samples = []   # (t, speed) injected by slide travel

    def cost(self, p, t):
        d = math.dist(self.pos, p)
        dt = max(t - self.free_at, 0.0)
        c = d / max(dt, 0.04)  # hurry factor: distance per available second
        # 交叉手 penalty: reaching clearly across the center
        if self.home_sign * p[0] < -0.25:
            c += CROSS_PENALTY
        return c


def simulate(events):
    """events: list of (t, kind, pos, busy_until, weight, curve, pos_end, travel).
    busy_until = hand occupancy; travel = real slide flight time [a:b].
    Greedy 2-hand assignment.

    Play-style model: onsets faster than ALTERNATE_MS apart are played with
    STRICT hand alternation (交互), regardless of position — that is how humans
    actually play fast streams. Slower onsets go to the cheaper (nearer) hand,
    which reproduces jacks / one-hand patterns correctly. Only when the
    alternation hand is busy (hold/slide) does the other hand take over.
    Slides (星星): hand is busy only a fixed SLIDE_BUSY_S (the star can be left
    alone), but the flight (real travel time) still injects a movement-speed
    sample and the hand ends up at the slide end point.
    """
    events = sorted(events, key=lambda e: e[0])
    L = Hand("L", btn_xy(7), home_sign=-1)
    R = Hand("R", btn_xy(3), home_sign=+1)
    last_hand = None          # hand that took the previous onset
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
            ev = group[0]
            t_, kind, p, busy, w, curve, p_end, trav = ev
            chosen = None
            # strict alternation for fast streams (交互): other hand, if free
            if last_hand is not None and (t - last_t) * 1000 < ALTERNATE_MS:
                other = R if last_hand is L else L
                if other.free_at <= t + 1e-6:
                    chosen = other
            if chosen is None:
                cand = [h for h in hands if h.free_at <= t + 1e-6]
                if cand:
                    chosen = min(cand, key=lambda h: h.cost(p, t))
                else:
                    chosen = min(hands, key=lambda h: h.free_at)
            chosen.pos = p_end if p_end is not None else p
            chosen.free_at = max(busy, t + BUSY_TAIL_S)
            chosen.onsets.append((t, p, True))
            if p_end is not None:
                chosen.onsets.append((t + trav, p_end, False))
                mult = CURVE_MULT.get(curve, 1.3)
                chosen.speed_samples.append(
                    (t, math.dist(p, p_end) * mult / max(trav, 0.05)))
            last_hand = chosen
        else:
            # chord: try both cross-hand assignments (no mutation), keep cheaper
            def try_cost(order, assign):
                c = 0.0
                for ev, h in zip(order, assign):
                    t_, kind, p, busy, w, curve, p_end, trav = ev
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
            for ev, h in best_apply:
                t_, kind, p, busy, w, curve, p_end, trav = ev
                h.pos = p_end if p_end is not None else p
                h.free_at = max(busy, t + BUSY_TAIL_S)
                h.onsets.append((t, p, True))
                if p_end is not None:
                    h.onsets.append((t + trav, p_end, False))
                    mult = CURVE_MULT.get(curve, 1.3)
                    h.speed_samples.append(
                        (t, math.dist(p, p_end) * mult / max(trav, 0.05)))
            last_hand = best_apply[-1][1]
        last_t = t
        i = j
    return L, R


# ------------------------------------------------------------------- metrics
def peak_rate_1s(onsets):
    if not onsets:
        return 0.0
    ts = [t for t, _, tap in onsets if tap]
    ts.sort()
    best = 0.0
    j = 0
    for i in range(len(ts)):
        while ts[i] - ts[j] > 1.0 + 1e-6:
            j += 1
        best = max(best, i - j + 1)
    return float(best)


def peak_speed(hand):
    """Peak same-hand tap-to-tap travel speed (buttons/s). Slide flights are
    NOT included here — their visual burden is counted in read_load; adding
    them here lets short fast slides (dist/0.05s clamp = 40+) blow up the
    metric and pin every score at the cap."""
    best = 0.0
    onsets = hand.onsets
    for a, b in zip(onsets, onsets[1:]):
        if not (a[2] and b[2]):
            continue
        dt = b[0] - a[0]
        if dt < 0.05 or dt > 2.0:
            continue
        best = max(best, math.dist(a[1], b[1]) / dt)
    return best


def evaluate(events_raw, title):
    """events_raw: (t, kind, pos_or_btn, extra, dur[, curve]). Returns metrics dict."""
    evs = []
    for raw in events_raw:
        t, kind, a, b, dur = raw[:5]
        if kind == "touch":
            # touches are guidance / rest-section flavour (引导+彩休), they add
            # no judgement pressure — excluded from difficulty entirely
            continue
        curve = raw[5] if len(raw) > 5 else ""
        p_end = None
        if kind == "map":
            w = 1.0
            p = (a, b)
        elif isinstance(a, int) and 1 <= a <= 8:
            w = 1.0
            p = btn_xy(a)
            if kind == "slide" and isinstance(b, int) and 1 <= b <= 8:
                p_end = btn_xy(b)
        else:
            w = 1.0
            p = (a, b)
        if kind == "hold":
            busy = t + dur
        elif kind == "slide":
            # stars occupy the tapping hand during the flight (capped at 2s
            # for pathological long slides); "leave the star" nuance lives in
            # the cap, the flight itself is real hand load for most players
            busy = t + min(dur, 2.0)
        else:
            busy = t
        evs.append((t, kind, p, busy, w, curve, p_end, dur))
    if not evs:
        return None
    L, R = simulate(evs)
    dur = max(e[0] for e in evs) - min(e[0] for e in evs)
    if dur <= 0:
        return None
    total_w = sum(e[4] for e in evs)
    peak_rate = max(peak_rate_1s(L.onsets), peak_rate_1s(R.onsets))
    ps = max(peak_speed(L), peak_speed(R))
    density = total_w / dur
    busy_time = sum(min(e[3] - e[0], 2.0) for e in evs)
    busy_ratio = min(busy_time / (2 * dur), 1.0)
    # reading burden: everything the eyes must track — plain note density,
    # hold attention span, and star flight paths (curve-weighted)
    star_path = 0.0
    for e in evs:
        if e[1] == "slide" and e[6] is not None:
            mult = CURVE_MULT.get(e[5], 1.3)
            star_path += math.dist(e[2], e[6]) * mult
    star_load = star_path / dur
    hold_span = sum(min(e[7], 2.0) for e in evs if e[1] == "hold")
    read_load = density + hold_span / dur + star_load
    score = (W_PEAK_RATE * peak_rate + W_PEAK_SPEED * ps + W_READ * read_load
             + W_BUSY * busy_ratio)
    score = max(SCORE_MIN, min(SCORE_MAX, score))
    return {
        "title": title,
        "score": round(score, 2),
        "peak_rate": peak_rate,
        "peak_speed": round(ps, 2),
        "density": round(density, 2),
        "busy_ratio": round(busy_ratio, 3),
        "star_load": round(star_load, 2),
        "read_load": round(read_load, 2),
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
