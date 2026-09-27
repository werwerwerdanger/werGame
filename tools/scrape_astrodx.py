#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Scrape AstroDX (https://adxdls.saop.cc) maimai chart maidata.txt files.

Data source facts (verified 2026-09-28, from site source repo github.com/AdingApkgg/adx-dl):
  - Chart catalog:        https://adxdls.saop.cc/charts/specs.json
                            { shortid: {dir, files:[{name,url,bytes}], groupDir, genreDir} }
  - Metadata (title/artist): https://adxdls.saop.cc/charts/search-index.json
                            [{id, slug, title, artist, aliases?...}]
  - maidata URL pattern:  <mirror>/<versionid>/<shortid>/maidata.txt
    where <versionid> is extracted from the track.mp3 URL inside specs.json
    (e.g. https://astrodx-charts.saop.cc/0/11/track.mp3 -> versionid 0).
  - Mirrors (same path structure, from download-sources.ts):
    primary r2 = astrodx-charts.saop.cc (maidata may 404 there),
    backups  alice / tsumugi / awmc(astrodx-charts-wmc) / g510.
    alice verified working for maidata.txt.

Only downloads the plain-text chart (maidata.txt). No audio/video/images.

Usage:
    python scrape_astrodx.py                 # full run, resumable (skips existing files)
    python scrape_astrodx.py --limit 20      # first 20 charts only (smoke test)
    python scrape_astrodx.py --out D:/data/astrodx
    python scrape_astrodx.py --workers 2     # be gentler to the server

Output layout:
    <out>/<shortid>/maidata.txt
    <out>/index.jsonl          one JSON line per chart: {shortid,title,artist,versionid,bytes,ok}
"""

import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

SITE = "https://adxdls.saop.cc"
SPECS_URL = SITE + "/charts/specs.json"
INDEX_URL = SITE + "/charts/search-index.json"

# failover order for maidata.txt (alice verified, r2 sometimes 404s on maidata)
MIRRORS = [
    "https://astrodx-charts-alice.saop.cc",
    "https://astrodx-charts-tsumugi.saop.cc",
    "https://astrodx-charts-wmc.saop.cc",
    "https://astrodx-charts-g510.saop.cc",
    "https://astrodx-charts.saop.cc",
]

UA = "Mozilla/5.0 (chart dataset fetcher; personal research use)"
TIMEOUT = 30
RETRIES = 3


def http_get(url: str, binary: bool = False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last_err = None
    for attempt in range(RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                data = r.read()
            return data if binary else data.decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, TimeoutError) as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET failed after {RETRIES} tries: {url} ({last_err})")


def versionid_of(entry: dict) -> str | None:
    """Extract versionid from the track.mp3 URL inside a specs.json entry."""
    for f in entry.get("files", []):
        url = f.get("url", "")
        marker = "astrodx-charts"
        if f.get("name") == "track.mp3" and marker in url:
            # .../<host>/<versionid>/<shortid>/track.mp3
            rest = url.split(marker, 1)[1].lstrip("/")
            parts = rest.split("/")
            if len(parts) >= 2:
                return parts[0]
    return None


def fetch_one(shortid: str, versionid: str, out_dir: Path) -> dict:
    """Download one maidata.txt with mirror failover. Returns result record."""
    chart_dir = out_dir / shortid
    dest = chart_dir / "maidata.txt"
    rec = {"shortid": shortid, "versionid": versionid, "ok": False}
    if dest.exists() and dest.stat().st_size > 0:
        rec.update(ok=True, bytes=dest.stat().st_size, skipped=True)
        return rec
    last_err = None
    for mirror in MIRRORS:
        url = f"{mirror}/{versionid}/{shortid}/maidata.txt"
        try:
            text = http_get(url)
            if not text.strip() or "&title=" not in text:
                raise RuntimeError("not a maidata payload")
            chart_dir.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(text.encode("utf-8"))
            rec.update(ok=True, bytes=len(text.encode("utf-8")), mirror=mirror)
            return rec
        except Exception as e:  # noqa: BLE001 - try next mirror
            last_err = e
            time.sleep(0.4)
    rec["error"] = str(last_err)
    return rec


def main() -> int:
    ap = argparse.ArgumentParser(description="Scrape AstroDX maidata.txt charts")
    ap.add_argument("--out", default="astrodx_charts", help="output directory")
    ap.add_argument("--workers", type=int, default=4, help="parallel downloads")
    ap.add_argument("--limit", type=int, default=0, help="only fetch first N charts (0=all)")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("[1/3] fetching specs.json ...", flush=True)
    specs = json.loads(http_get(SPECS_URL))
    print(f"      {len(specs)} charts in catalog")

    try:
        print("[2/3] fetching search-index.json ...", flush=True)
        idx = json.loads(http_get(INDEX_URL))
        meta = {e["slug"]: e for e in idx if e.get("slug")}
    except Exception as e:  # noqa: BLE001 - metadata is optional
        print(f"      search-index failed ({e}), continuing without titles")
        meta = {}

    # shortid -> (versionid, title, artist)
    jobs = []
    for shortid, entry in specs.items():
        vid = versionid_of(entry)
        if vid is None:
            print(f"  !! no versionid for shortid {shortid}, skipped")
            continue
        m = meta.get(shortid, {})
        jobs.append((shortid, vid, m.get("title", ""), m.get("artist", "")))
    if args.limit > 0:
        jobs = jobs[: args.limit]
    print(f"[3/3] downloading {len(jobs)} maidata.txt with {args.workers} workers ...")

    ok = fail = 0
    index_path = out_dir / "index.jsonl"
    with index_path.open("w", encoding="utf-8") as index_f, \
            ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(fetch_one, sid, vid, out_dir): (sid, vid, t, a)
                for sid, vid, t, a in jobs}
        for fut in as_completed(futs):
            sid, vid, title, artist = futs[fut]
            try:
                rec = fut.result()
            except Exception as e:  # noqa: BLE001
                rec = {"shortid": sid, "versionid": vid, "ok": False, "error": str(e)}
            rec.update(title=title, artist=artist)
            index_f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if rec.get("ok"):
                ok += 1
                tag = "skip" if rec.get("skipped") else f"ok {rec.get('bytes', 0)}B"
                print(f"  {sid:>8} {tag}")
            else:
                fail += 1
                print(f"  {sid:>8} FAIL {rec.get('error', '')[:100]}")
    print(f"done: {ok} ok / {fail} failed, index -> {index_path}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
