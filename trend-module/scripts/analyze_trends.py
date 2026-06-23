#!/usr/bin/env python3
"""
trend-module/scripts/analyze_trends.py

Phase 3 of the trend module: trend event detection.

Reads the time-series data ingested by ingest_trends.py from Upstash,
computes week-over-week interest changes per sub-category, applies
industry-specific thresholds, and writes trend event records back to
Upstash for the outreach processor to consume.

Methodology:
    - For each query's time-series: average the most recent 7 days
      vs the trailing 28 days (excluding the recent 7). The percentage
      change between these averages is the trend signal.
    - Filter out sub-categories whose recent average is too low to be
      meaningful (MIN_RECENT_AVG_THRESHOLD).
    - Within each industry, sub-categories that exceed the industry's
      trend_threshold_pct become "trending sub-categories".
    - If an industry has ≥1 trending sub-categories AND we're in an
      active season for that industry, a trend event is emitted with
      the top trending sub-categories embedded as a list.

Output stored under keys:
    trend:event:{industry}:{country}:{date}   → trend event payload
    trend:events:by-industry:{industry}       → sorted set indexing events
    trend:analysis:{timestamp}                → run metadata

Usage:
    python3 analyze_trends.py             # Run analysis, write events
    python3 analyze_trends.py --dry-run   # Compute but don't write events
    python3 analyze_trends.py --cli       # Print sorted table for calibration
    python3 analyze_trends.py --cli --industry garden_outdoor  # Single industry
"""

import argparse
import csv
import json
import logging
import os
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

# ── Configuration ───────────────────────────────────────────────────────────

# Window definitions (in days).
RECENT_WINDOW_DAYS = 7
TRAILING_WINDOW_DAYS = 28

# Volume floors — with dense US-English data these can be modest, but they still
# guard against residual noise. A flagged sub-category must clear BOTH:
#   • recent_avg ≥ MIN_RECENT_AVG_THRESHOLD  (meaningful current interest)
#   • trailing_avg ≥ MIN_TRAILING_AVG_THRESHOLD  (a real baseline to grow FROM —
#     this is what kills "0 → spike = 999%" and "3.5 → 14 = huge%" artifacts at
#     the root, rather than capping them at 999 and letting them top the list)
MIN_RECENT_AVG_THRESHOLD = 10.0
MIN_TRAILING_AVG_THRESHOLD = 8.0

# Max trending sub-categories embedded in a single trend event.
MAX_TRENDING_SUBCATS_PER_EVENT = 5

# How long events live in Upstash before expiring (60 days matches framework).
EVENT_TTL_SECONDS = 60 * 24 * 60 * 60

# Country → language mapping (mirrors ingest_trends.py).
COUNTRY_TO_LANGUAGE = {
    "DK": "da", "SE": "sv", "NO": "no", "DE": "de", "AT": "de", "CH": "de",
    "NL": "nl", "BE": "nl", "UK": "en", "IE": "en", "US": "en",
    "FR": "fr", "ES": "es", "PT": "pt", "IT": "it", "FI": "fi",
}

# ── Logging setup ───────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("analyze_trends")


# ── Upstash client ──────────────────────────────────────────────────────────

class UpstashClient:
    """REST wrapper for Upstash: GET, SET, SCAN, ZADD."""

    def __init__(self, base_url: str, token: str, dry_run: bool = False):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.dry_run = dry_run
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {token}"

    def get_json(self, key: str):
        """Get a key's JSON-encoded value. Returns parsed object or None."""
        url = f"{self.base_url}/get/{key}"
        try:
            r = self.session.get(url, timeout=10)
            r.raise_for_status()
            body = r.json()
            if body.get("result") is None:
                return None
            return json.loads(body["result"])
        except Exception as e:
            log.warning(f"  GET {key} failed: {e}")
            return None

    def scan_keys(self, prefix: str) -> list:
        """Return all keys matching prefix*. Uses SCAN under the hood."""
        keys = []
        cursor = "0"
        match_pattern = f"{prefix}*"
        while True:
            url = f"{self.base_url}/scan/{cursor}?match={match_pattern}&count=200"
            try:
                r = self.session.get(url, timeout=10)
                r.raise_for_status()
                result = r.json().get("result", [])
                if not result or len(result) < 2:
                    break
                cursor = result[0]
                batch = result[1]
                keys.extend(batch)
                if cursor == "0":
                    break
            except Exception as e:
                log.error(f"  SCAN failed at cursor={cursor}: {e}")
                break
        return keys

    def set_json(self, key: str, value, ex_seconds: int) -> bool:
        """Set a key to a JSON-encoded value with TTL."""
        if self.dry_run:
            log.info(f"  [dry-run] would SET {key} (ttl {ex_seconds}s)")
            return True
        payload = json.dumps(value, separators=(",", ":"))
        url = f"{self.base_url}/set/{key}?EX={ex_seconds}"
        try:
            r = self.session.post(url, data=payload, timeout=10)
            r.raise_for_status()
            return True
        except Exception as e:
            log.error(f"  Upstash SET {key} failed: {e}")
            return False

    def zadd(self, key: str, score: float, member: str) -> bool:
        """Add member to sorted set with score."""
        if self.dry_run:
            log.info(f"  [dry-run] would ZADD {key} {score} {member}")
            return True
        url = f"{self.base_url}/zadd/{key}/{score}/{member}"
        try:
            r = self.session.post(url, timeout=10)
            r.raise_for_status()
            return True
        except Exception as e:
            log.error(f"  Upstash ZADD {key} failed: {e}")
            return False


# ── Trend math ──────────────────────────────────────────────────────────────

def compute_trend_signal(data_points: list) -> dict:
    """
    Given a list of {date, interest} points (chronological), compute:
        recent_avg     — mean of last RECENT_WINDOW_DAYS
        trailing_avg   — mean of the TRAILING_WINDOW_DAYS preceding the recent window
        wow_change_pct — percentage change between trailing and recent

    Returns a dict with all three, or None if there's not enough data.
    """
    if len(data_points) < RECENT_WINDOW_DAYS + TRAILING_WINDOW_DAYS:
        return None

    # Take the most recent 7 days
    recent = data_points[-RECENT_WINDOW_DAYS:]
    # And the 28 days before that
    trailing_end = len(data_points) - RECENT_WINDOW_DAYS
    trailing_start = trailing_end - TRAILING_WINDOW_DAYS
    trailing = data_points[trailing_start:trailing_end]

    recent_values = [p["interest"] for p in recent]
    trailing_values = [p["interest"] for p in trailing]

    recent_avg = statistics.mean(recent_values)
    trailing_avg = statistics.mean(trailing_values)

    # Percentage change. A near-zero baseline can't produce a meaningful
    # percentage — "0 → something" isn't a trend, it's noise on a query with no
    # real history. Flag those as insufficient_baseline so the caller can skip
    # them, rather than capping at 999 (which falsely puts them at the TOP).
    insufficient_baseline = trailing_avg < MIN_TRAILING_AVG_THRESHOLD
    if trailing_avg == 0:
        wow_change_pct = 0 if recent_avg == 0 else 999  # retained for display only
    else:
        wow_change_pct = ((recent_avg - trailing_avg) / trailing_avg) * 100

    return {
        "recent_avg": round(recent_avg, 2),
        "trailing_avg": round(trailing_avg, 2),
        "wow_change_pct": round(wow_change_pct, 1),
        "insufficient_baseline": insufficient_baseline,
    }


# ── Analysis core ───────────────────────────────────────────────────────────

def parse_query_key(key: str) -> tuple:
    """
    Parse 'trend:query:{industry}:{country}:{sub_category}' into a tuple.
    Returns (industry, country, sub_category) or None if malformed.
    """
    parts = key.split(":", 4)
    if len(parts) != 5 or parts[0] != "trend" or parts[1] != "query":
        return None
    return (parts[2], parts[3], parts[4])


def is_in_active_season(industry: dict) -> bool:
    """Check if the current month is within the industry's active months."""
    active_months = industry.get("seasonal_active_months", [])
    if not active_months:
        return True  # Empty list means year-round
    current_month = datetime.now(timezone.utc).month
    return current_month in active_months


def analyze(industries_data: dict, upstash: UpstashClient, industry_filter: str | None,
            country_filter: str | None) -> dict:
    """
    Main analysis loop. Returns a structured report of trend events.
    """
    summary = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "completed_at": None,
        "queries_analyzed": 0,
        "queries_skipped_insufficient_data": 0,
        "queries_skipped_low_volume": 0,
        "trending_subcats_detected": 0,
        "events_generated": 0,
        "events_per_industry": {},
        "all_signals": [],  # full list, used by CLI mode
    }

    # Build a slug → industry config map for fast lookup
    industry_map = {ind["slug"]: ind for ind in industries_data["industries"]}

    # Group sub-category signals by (industry, country)
    grouped_signals = {}  # (industry, country) → [signal records]

    # Scan all trend:query:* keys in Upstash
    log.info("Scanning Upstash for ingested time-series...")
    keys = upstash.scan_keys("trend:query:")
    log.info(f"Found {len(keys)} ingested datasets")

    for key in keys:
        parsed = parse_query_key(key)
        if not parsed:
            continue
        industry_slug, country, sub_cat_key = parsed

        # Apply filters
        if industry_filter and industry_slug != industry_filter:
            continue
        if country_filter and country != country_filter:
            continue

        # Look up the industry config
        industry = industry_map.get(industry_slug)
        if not industry or not industry.get("enabled"):
            continue

        # Read the time-series data
        data = upstash.get_json(key)
        if not data or "data_points" not in data:
            continue

        signal = compute_trend_signal(data["data_points"])
        if signal is None:
            summary["queries_skipped_insufficient_data"] += 1
            continue

        summary["queries_analyzed"] += 1

        # Capture full record for CLI/reporting. Include the local (Danish)
        # outreach keyword alongside the English analysis term.
        translations = data.get("translations", {}) or {}
        record = {
            "industry": industry_slug,
            "country": country,
            "sub_category": sub_cat_key,
            "query_text_used": data.get("query_text_used", sub_cat_key),  # English (queried)
            "query_language": data.get("query_language"),
            "da_keyword": data.get("da_keyword") or translations.get("da", ""),  # outreach output
            **signal,
        }
        summary["all_signals"].append(record)

        # Skip queries with no meaningful baseline to grow FROM (kills the
        # 0→spike=999% and tiny-base artifacts at the root).
        if signal.get("insufficient_baseline"):
            summary["queries_skipped_low_volume"] += 1
            continue

        # Filter low recent-volume queries (high % change on near-zero base is noise)
        if signal["recent_avg"] < MIN_RECENT_AVG_THRESHOLD:
            summary["queries_skipped_low_volume"] += 1
            continue

        # Check against industry threshold
        threshold = industry.get("trend_threshold_pct")
        if threshold is None:
            continue
        if signal["wow_change_pct"] < threshold:
            continue

        # This sub-category is trending. Group with its (industry, country).
        summary["trending_subcats_detected"] += 1
        grouping_key = (industry_slug, country)
        grouped_signals.setdefault(grouping_key, []).append(record)

    # Now build trend events. One event per (industry, country) where ≥1
    # sub-category is trending AND the industry is in its active season.
    log.info("━" * 60)
    log.info("Generating trend events...")

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    for (industry_slug, country), trending_records in grouped_signals.items():
        industry = industry_map[industry_slug]

        if not is_in_active_season(industry):
            log.info(f"  Skipping {industry_slug}/{country}: outside active season "
                     f"(active months: {industry.get('seasonal_active_months', [])})")
            continue

        # Sort trending sub-cats by wow_change_pct descending, take top N
        trending_records.sort(key=lambda r: r["wow_change_pct"], reverse=True)
        top_subcats = trending_records[:MAX_TRENDING_SUBCATS_PER_EVENT]

        event_id = f"evt_{today}_{industry_slug}_{country}"
        event = {
            "event_id": event_id,
            "industry": industry_slug,
            "industry_name": industry.get("name", industry_slug),
            "country": country,
            "language": COUNTRY_TO_LANGUAGE.get(country, "en"),
            "trending_queries": [
                {
                    "sub_category": r["sub_category"],
                    "query_text": r["query_text_used"],
                    "recent_avg": r["recent_avg"],
                    "trailing_avg": r["trailing_avg"],
                    "wow_change_pct": r["wow_change_pct"],
                }
                for r in top_subcats
            ],
            "threshold_used": industry.get("trend_threshold_pct"),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        # Write to Upstash
        event_key = f"trend:event:{industry_slug}:{country}:{today}"
        if upstash.set_json(event_key, event, EVENT_TTL_SECONDS):
            # Also index in sorted set for time-range queries later
            score = datetime.now(timezone.utc).timestamp()
            upstash.zadd(f"trend:events:by-industry:{industry_slug}", score, event_id)
            summary["events_generated"] += 1
            summary["events_per_industry"].setdefault(industry_slug, 0)
            summary["events_per_industry"][industry_slug] += 1

            log.info(f"  ✓ Event: {industry_slug}/{country} — "
                     f"{len(top_subcats)} trending: " +
                     ", ".join(f"{r['sub_category']} (+{r['wow_change_pct']}%)"
                               for r in top_subcats[:3]) +
                     ("..." if len(top_subcats) > 3 else ""))

    summary["completed_at"] = datetime.now(timezone.utc).isoformat()
    return summary


# ── CLI table output ────────────────────────────────────────────────────────

def print_cli_table(all_signals: list, industry_filter: str | None):
    """Pretty-print all signals sorted by wow_change_pct, descending."""
    if not all_signals:
        log.info("No signals to display")
        return

    # Filter (if requested) and sort
    signals = all_signals
    if industry_filter:
        signals = [s for s in signals if s["industry"] == industry_filter]
    signals = sorted(signals, key=lambda s: s["wow_change_pct"], reverse=True)

    # Header
    print()
    print(f"{'Industry':<22} {'Country':<7} {'Sub-category':<22} "
          f"{'Recent avg':>11} {'Trail avg':>11} {'WoW change':>11}")
    print("─" * 88)

    for s in signals:
        # Clip very long names for clean output
        ind = s["industry"][:22]
        sub = s["sub_category"][:22]
        change_str = f"{s['wow_change_pct']:+.1f}%"
        print(f"{ind:<22} {s['country']:<7} {sub:<22} "
              f"{s['recent_avg']:>11.2f} {s['trailing_avg']:>11.2f} "
              f"{change_str:>11}")

    print()
    print(f"Total signals shown: {len(signals)}")


# ── CSV report output ───────────────────────────────────────────────────────

def write_csv_report(all_signals: list, industries_data: dict, out_dir: str | None) -> str | None:
    """
    Write the full ranked signal list to a dated CSV for weekly validation/eyeball.
    Includes a `flagged` column: True when the sub-category cleared BOTH the
    low-volume floor (MIN_RECENT_AVG_THRESHOLD) and its industry threshold
    (trend_threshold_pct from industries.json). Returns the file path, or None.

    The CSV is the *full* distribution (not just risers) so thresholds can be
    calibrated from evidence; filter on the `flagged` column to see only risers.
    """
    if not all_signals:
        log.info("No signals to write to CSV")
        return None

    # Per-industry threshold lookup (Knob 1). Missing threshold → never flagged.
    thresholds = {
        ind["slug"]: ind.get("trend_threshold_pct")
        for ind in industries_data["industries"]
    }

    # Resolve output directory: default to ../../trend-reports relative to script
    if out_dir:
        reports_dir = Path(out_dir)
    else:
        script_dir = Path(__file__).resolve().parent
        reports_dir = script_dir.parent.parent / "trend-reports"
    reports_dir.mkdir(parents=True, exist_ok=True)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out_path = reports_dir / f"trends-{today}.csv"

    # Sort by wow_change_pct descending so the CSV opens with the biggest risers
    rows = sorted(all_signals, key=lambda s: s["wow_change_pct"], reverse=True)

    fieldnames = [
        "industry", "country", "sub_category",
        "query_en", "query_da",
        "recent_avg", "trailing_avg", "wow_change_pct", "threshold_pct",
        "meets_volume_floor", "meets_baseline_floor", "flagged",
    ]

    def is_flagged(s, thr):
        meets_volume = s["recent_avg"] >= MIN_RECENT_AVG_THRESHOLD
        meets_baseline = s["trailing_avg"] >= MIN_TRAILING_AVG_THRESHOLD
        return (
            meets_volume and meets_baseline
            and thr is not None and s["wow_change_pct"] >= thr
        ), meets_volume, meets_baseline

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for s in rows:
            thr = thresholds.get(s["industry"])
            flagged, meets_volume, meets_baseline = is_flagged(s, thr)
            writer.writerow({
                "industry": s["industry"],
                "country": s["country"],
                "sub_category": s["sub_category"],
                "query_en": s.get("query_text_used", ""),   # English term (analyzed)
                "query_da": s.get("da_keyword", ""),          # Danish keyword (outreach output)
                "recent_avg": s["recent_avg"],
                "trailing_avg": s["trailing_avg"],
                "wow_change_pct": s["wow_change_pct"],
                "threshold_pct": thr if thr is not None else "",
                "meets_volume_floor": meets_volume,
                "meets_baseline_floor": meets_baseline,
                "flagged": flagged,
            })

    flagged_count = sum(1 for s in rows if is_flagged(s, thresholds.get(s["industry"]))[0])
    log.info(f"CSV report written: {out_path} ({len(rows)} rows, {flagged_count} flagged)")
    return str(out_path)


# ── Entry point ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Trend event detection")
    parser.add_argument("--dry-run", action="store_true",
                        help="Compute but don't write events to Upstash")
    parser.add_argument("--cli", action="store_true",
                        help="Print sorted table of all signals (calibration mode)")
    parser.add_argument("--csv", action="store_true",
                        help="Write a dated CSV report of all signals to trend-reports/")
    parser.add_argument("--csv-dir", type=str, default=None,
                        help="Output directory for the CSV (default: ../../trend-reports)")
    parser.add_argument("--industry", type=str, default=None,
                        help="Limit analysis to one industry slug")
    parser.add_argument("--country", type=str, default=None,
                        help="Limit analysis to one country code")
    parser.add_argument("--taxonomy-path", type=str, default=None,
                        help="Path to industries.json (default: ../industries.json)")
    args = parser.parse_args()

    # Resolve taxonomy path
    if args.taxonomy_path:
        taxonomy_path = Path(args.taxonomy_path)
    else:
        script_dir = Path(__file__).resolve().parent
        taxonomy_path = script_dir.parent / "industries.json"

    log.info(f"Loading taxonomy: {taxonomy_path}")
    if not taxonomy_path.exists():
        log.error(f"Taxonomy file not found: {taxonomy_path}")
        sys.exit(1)

    with open(taxonomy_path) as f:
        industries_data = json.load(f)

    # Upstash credentials
    upstash_url = os.environ.get("UPSTASH_REDIS_REST_URL")
    upstash_token = os.environ.get("UPSTASH_REDIS_REST_TOKEN")

    if not upstash_url or not upstash_token:
        log.error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set")
        sys.exit(1)

    # In CLI mode, we always run dry (don't write events even if --dry-run not set,
    # because the user just wants to look at data)
    effective_dry_run = args.dry_run or args.cli

    upstash = UpstashClient(
        base_url=upstash_url,
        token=upstash_token,
        dry_run=effective_dry_run,
    )

    log.info(f"Mode: {'CLI' if args.cli else ('DRY-RUN' if args.dry_run else 'LIVE')} | "
             f"Industry filter: {args.industry or 'all enabled'} | "
             f"Country filter: {args.country or 'all'}")

    summary = analyze(industries_data, upstash, args.industry, args.country)

    # Write run summary unless CLI mode
    if not args.cli:
        run_id = summary["started_at"].replace(":", "-").replace(".", "-")
        upstash.set_json(f"trend:analysis:{run_id}", summary, EVENT_TTL_SECONDS)

    log.info("━" * 60)
    log.info(
        f"Analysis complete: {summary['queries_analyzed']} queries analyzed, "
        f"{summary['trending_subcats_detected']} trending sub-categories, "
        f"{summary['events_generated']} events generated"
    )
    if summary["queries_skipped_low_volume"]:
        log.info(f"Skipped (low volume): {summary['queries_skipped_low_volume']}")
    if summary["queries_skipped_insufficient_data"]:
        log.info(f"Skipped (insufficient data): {summary['queries_skipped_insufficient_data']}")

    if args.cli:
        print_cli_table(summary["all_signals"], args.industry)

    if args.csv:
        write_csv_report(summary["all_signals"], industries_data, args.csv_dir)


if __name__ == "__main__":
    main()
