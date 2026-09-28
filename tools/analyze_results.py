#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Summarize chart_difficulty --json output vs official maimai levels.

Usage: python analyze_results.py <results.jsonl> [--out report.md]
Prints: coverage, Pearson/Spearman correlation per difficulty, score stats,
worst/best calibration buckets, and top-20 estimated charts.
"""

import argparse
import json
import math
import sys
from collections import defaultdict


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return float("nan")
    mx = sum(xs) / n
    my = sum(ys) / n
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if sx == 0 or sy == 0:
        return float("nan")
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)


def spearman(xs, ys):
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r
    return pearson(rank(xs), rank(ys))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("--out", help="write markdown report")
    args = ap.parse_args()

    rows = []
    with open(args.results, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    print(f"rows: {len(rows)}")

    scored = [r for r in rows if r.get("official_lv") is not None]
    print(f"rows with official lv: {len(scored)}")

    lines = ["# AstroDX 难度评估器校准报告", ""]
    by_diff = defaultdict(list)
    for r in scored:
        by_diff[r["diff"]].append(r)

    lines.append("| 难度 | n | Pearson | Spearman | est均值 | est极差 | 官方均值 |")
    lines.append("|---|---|---|---|---|---|---|")
    for diff in ("Basic", "Advanced", "Expert", "Master", "ReMaster"):
        rs = by_diff.get(diff, [])
        if not rs:
            continue
        xs = [r["score"] for r in rs]
        ys = [r["official_lv"] for r in rs]
        lines.append(f"| {diff} | {len(rs)} | {pearson(xs, ys):.3f} | "
                     f"{spearman(xs, ys):.3f} | {sum(xs)/len(xs):.2f} | "
                     f"{min(xs):.1f}~{max(xs):.1f} | {sum(ys)/len(ys):.2f} |")
    print("\n".join(lines))

    xs = [r["score"] for r in scored]
    ys = [r["official_lv"] for r in scored]
    print(f"\nALL: n={len(scored)} pearson={pearson(xs, ys):.3f} spearman={spearman(xs, ys):.3f}")

    top = sorted(rows, key=lambda r: -r["score"])[:20]
    print("\nTop-20 estimated:")
    for r in top:
        off = f"{r['official_lv']:.1f}" if r.get("official_lv") is not None else "-"
        print(f"  {r['score']:>5.2f} (official {off:>5}) {r['title'][:30]:<30} "
              f"[{r.get('diff','-')}] rate={r['peak_rate']:.0f} move={r['peak_speed']:.1f} "
              f"read={r.get('read_load',0):.1f}")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
            f.write(f"\nALL: n={len(scored)} pearson={pearson(xs, ys):.3f} "
                    f"spearman={spearman(xs, ys):.3f}\n")
            f.write("\n## Top-20 estimated\n\n| est | official | title | diff |\n|---|---|---|---|\n")
            for r in top:
                off = f"{r['official_lv']:.1f}" if r.get("official_lv") is not None else "-"
                f.write(f"| {r['score']:.2f} | {off} | {r['title']} | {r.get('diff','-')} |\n")
        print(f"\n-> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
