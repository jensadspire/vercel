#!/usr/bin/env python3
"""
trend-module/scripts/ingest_trends.py

Phase 2 of the trend module: pytrends ingestion script.

Reads trend-module/industries.json, iterates through enabled industries and
their sub-category queries, fetches Google Trends interest-over-time data via
pytrends, and stores results in Upstash Redis for later analysis.

Runs weekly via GitHub Actions. v1 scope: DK only.

Output stored under keys:
    trend:query:{slug}:{country}:{sub_category}    → JSON time-series payload
    trend:run:{timestamp}                           → Run metadata (logs, errors)

Environment variables required:
    UPSTASH_REDIS_REST_URL   — Upstash REST API base URL
    UPSTASH_REDIS_REST_TOKEN — Upstash REST API token

Usage:
    python3 ingest_trends.py             # Run normally
    python3 ingest_trends.py --dry-run   # Don't write to Upstash, just log
    python3 ingest_trends.py --industry garden_outdoor  # Limit to one industry
"""

import argparse
import json
import logging
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from pytrends.request import TrendReq

# ── Configuration ───────────────────────────────────────────────────────────

# ── Analysis geo (data-density proxy) ───────────────────────────────────────
# We query Google Trends in ENGLISH at a high-volume geo, NOT in each prospect's
# local language/country. Rationale: small language areas (e.g. DK ~6M speakers)
# return sparse, spiky time-series full of zeros, producing noise artifacts
# (0→spike = 999%, single-day blips = fake trends). Querying the English term at
# a large market gives dense, smooth, statistically meaningful curves. Seasonal
# demand is hemispheric (sunscreen rises in summer in US and DK alike), so a
# Northern-Hemisphere English market is a sound proxy for "what's heating up".
#
# This is DECOUPLED from industry.primary_countries (which describes where the
# PROSPECTS are, for outreach targeting — a different concern). Every enabled
# industry is analyzed at ANALYSIS_GEO regardless of its primary_countries.
#
# v1: US only (densest single English market). To expand to a basket later
# (e.g. ["US", "GB"]), make this a list and average the series — note that
# doubles the rate-limited request count, so adjust the workflow timeout.
ANALYSIS_GEO = "US"
ANALYSIS_LANG = "en"  # query the English term; local keyword is the OUTPUT, not the query

# The Upstash key uses this as the geo segment. Kept distinct from the prospect
# country so US-analysis keys (trend:query:{ind}:US:{sub}) coexist with any
# legacy per-country keys, which expire via TTL.
GEO_KEY_SEGMENT = ANALYSIS_GEO

# Country → language mapping for taxonomy localization. The script looks up
# the sub-category's translation for this language before querying pytrends.
# Countries not in this map will fall back to the English term.
COUNTRY_TO_LANGUAGE = {
    "DK": "da",
    "SE": "sv",
    "NO": "no",
    "DE": "de",
    "AT": "de",
    "CH": "de",
    "NL": "nl",
    "BE": "nl",
    "UK": "en",
    "IE": "en",
    "US": "en",
    "FR": "fr",
    "ES": "es",
    "PT": "pt",
    "IT": "it",
    "FI": "fi",
}

# Pytrends rate limit pacing. Google's unofficial limit is roughly 1 request
# per 5 seconds sustained. Going slower is safer; going faster invites bans.
SECONDS_BETWEEN_QUERIES = 6.0

# Random jitter added to the base delay to look less robotic.
JITTER_SECONDS = 2.0

# Time window for pytrends. "today 3-m" gives daily data for the last 90 days,
# which is enough for week-over-week analysis with comfortable history.
PYTRENDS_TIMEFRAME = "today 3-m"

# How long Upstash should retain trend data. 90 days matches the framework
# document's TTL spec.
UPSTASH_TTL_SECONDS = 90 * 24 * 60 * 60

# Max retries on transient pytrends errors before giving up on a query.
MAX_RETRIES_PER_QUERY = 3

# ── Logging setup ───────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("ingest_trends")


# ── Upstash REST client ─────────────────────────────────────────────────────

class UpstashClient:
    """Thin REST wrapper for Upstash Redis. Only needs SET with EX."""

    def __init__(self, base_url: str, token: str, dry_run: bool = False):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.dry_run = dry_run
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {token}"

    def set_json(self, key: str, value, ex_seconds: int) -> bool:
        """Set a key to a JSON-encoded value with TTL. Returns True on success."""
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


# ── Pytrends fetcher ────────────────────────────────────────────────────────

def fetch_query_interest(pytrends: TrendReq, query: str, country: str) -> dict | None:
    """
    Fetch interest-over-time for one query in one country. Returns a dict:
        {
          "query": "...",
          "country": "...",
          "timeframe": "today 3-m",
          "fetched_at": "2026-...",
          "data_points": [ {"date": "2026-03-01", "interest": 45}, ... ]
        }
    Returns None on failure after retries.
    """
    for attempt in range(1, MAX_RETRIES_PER_QUERY + 1):
        try:
            pytrends.build_payload(
                kw_list=[query],
                cat=0,
                timeframe=PYTRENDS_TIMEFRAME,
                geo=country,
                gprop="",
            )
            df = pytrends.interest_over_time()

            if df is None or df.empty:
                log.info(f"  No data for '{query}' in {country} (low search volume)")
                return "EMPTY"

            # Drop the 'isPartial' column if present (pytrends adds it)
            if "isPartial" in df.columns:
                df = df.drop(columns=["isPartial"])

            data_points = [
                {"date": idx.strftime("%Y-%m-%d"), "interest": int(row[query])}
                for idx, row in df.iterrows()
            ]

            return {
                "query": query,
                "country": country,
                "timeframe": PYTRENDS_TIMEFRAME,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "data_points": data_points,
            }

        except Exception as e:
            log.warning(
                f"  Attempt {attempt}/{MAX_RETRIES_PER_QUERY} failed for "
                f"'{query}' in {country}: {e}"
            )
            if attempt < MAX_RETRIES_PER_QUERY:
                # Exponential backoff on retries
                time.sleep(10 * attempt)

    log.error(f"  Giving up on '{query}' in {country} after {MAX_RETRIES_PER_QUERY} attempts")
    return None


# ── Sleep with jitter ───────────────────────────────────────────────────────

def paced_sleep():
    """Sleep between queries with light randomization."""
    delay = SECONDS_BETWEEN_QUERIES + random.uniform(0, JITTER_SECONDS)
    time.sleep(delay)


# ── Main ingestion loop ─────────────────────────────────────────────────────

def ingest(industries_data: dict, upstash: UpstashClient, industry_filter: str | None):
    """Iterate enabled industries × v1 countries × sub-categories. Write each
    result to Upstash. Returns a run-summary dict."""

    summary = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "completed_at": None,
        "total_queries_attempted": 0,
        "total_queries_succeeded": 0,
        "total_queries_empty": 0,
        "total_queries_failed": 0,
        "industries_processed": [],
        "errors": [],
    }

    pytrends = TrendReq(hl="en-US", tz=0, retries=2, backoff_factor=0.5)

    for industry in industries_data["industries"]:
        if not industry.get("enabled"):
            continue
        if industry_filter and industry["slug"] != industry_filter:
            continue

        # Analysis geo is decoupled from primary_countries — we query EVERY
        # enabled industry at ANALYSIS_GEO in English. primary_countries is left
        # intact for the outreach-targeting side.
        sub_categories = industry.get("sub_categories", [])
        if not sub_categories:
            log.info(f"Skipping {industry['slug']} — no sub-categories defined")
            continue

        log.info(
            f"━━━ Industry: {industry['slug']} "
            f"({len(sub_categories)} queries @ geo={ANALYSIS_GEO}, {ANALYSIS_LANG}) ━━━"
        )

        industry_summary = {
            "slug": industry["slug"],
            "queries_succeeded": 0,
            "queries_failed": 0,
        }

        # Single analysis geo (English). Loop kept as a list for easy basket
        # expansion later (e.g. for geo in ["US", "GB"]).
        for country in [ANALYSIS_GEO]:
            lang = ANALYSIS_LANG

            for sub_cat in sub_categories:
                # Resolve query string. We query the ENGLISH term (dense data);
                # the local translation is stored for the outreach OUTPUT, not
                # used as the query.
                if isinstance(sub_cat, dict):
                    en_term = sub_cat.get("en", "")
                    query_text = en_term  # always query English
                    key_sub = en_term
                    # Keep the Danish (and any) translations on the payload so the
                    # analyzer can surface the local outreach keyword side-by-side.
                    translations = sub_cat.get("translations", {}) or {}
                else:
                    query_text = sub_cat
                    key_sub = sub_cat
                    translations = {}

                if not query_text:
                    log.warning(f"  Skipping sub-category with no query text in {industry['slug']}")
                    continue

                summary["total_queries_attempted"] += 1
                log.info(f"  Fetching '{query_text}' (en) @ {country}...")

                result = fetch_query_interest(pytrends, query_text, country)

                if result == "EMPTY":
                    summary["total_queries_empty"] = summary.get("total_queries_empty", 0) + 1
                    industry_summary["queries_empty"] = industry_summary.get("queries_empty", 0) + 1
                elif result is not None:
                    safe_sub = key_sub.replace(" ", "_").lower()
                    key = f"trend:query:{industry['slug']}:{GEO_KEY_SEGMENT}:{safe_sub}"
                    if isinstance(result, dict):
                        result["query_language"] = lang
                        result["query_text_used"] = query_text
                        result["analysis_geo"] = country
                        # Store local translations for the outreach output side.
                        result["translations"] = translations
                        result["da_keyword"] = translations.get("da", "")
                    if upstash.set_json(key, result, UPSTASH_TTL_SECONDS):
                        summary["total_queries_succeeded"] += 1
                        industry_summary["queries_succeeded"] += 1
                    else:
                        summary["total_queries_failed"] += 1
                        industry_summary["queries_failed"] += 1
                        summary["errors"].append(
                            f"Upstash write failed: {industry['slug']}/{country}/{key_sub}"
                        )
                else:
                    summary["total_queries_failed"] += 1
                    industry_summary["queries_failed"] += 1
                    summary["errors"].append(
                        f"Pytrends fetch failed: {industry['slug']}/{country}/{key_sub}"
                    )

                paced_sleep()

        summary["industries_processed"].append(industry_summary)

    summary["completed_at"] = datetime.now(timezone.utc).isoformat()
    return summary


# ── Entry point ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Pytrends ingestion for trend module")
    parser.add_argument("--dry-run", action="store_true", help="Don't write to Upstash")
    parser.add_argument("--industry", type=str, default=None, help="Limit to one industry slug")
    parser.add_argument(
        "--taxonomy-path",
        type=str,
        default=None,
        help="Path to industries.json (default: ../industries.json relative to this script)",
    )
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

    if not args.dry_run and (not upstash_url or not upstash_token):
        log.error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set")
        sys.exit(1)

    upstash = UpstashClient(
        base_url=upstash_url or "",
        token=upstash_token or "",
        dry_run=args.dry_run,
    )

    log.info(
        f"Mode: {'DRY-RUN' if args.dry_run else 'LIVE'} | "
        f"Analysis geo: {ANALYSIS_GEO} ({ANALYSIS_LANG}) | "
        f"Industry filter: {args.industry or 'all enabled'}"
    )

    summary = ingest(industries_data, upstash, args.industry)

    # Write run summary to Upstash
    run_id = summary["started_at"].replace(":", "-").replace(".", "-")
    run_key = f"trend:run:{run_id}"
    upstash.set_json(run_key, summary, UPSTASH_TTL_SECONDS)

    # Print summary to stdout
    log.info("━" * 60)
    succeeded = summary["total_queries_succeeded"]
    attempted = summary["total_queries_attempted"]
    empty = summary.get("total_queries_empty", 0)
    failed = summary["total_queries_failed"]
    log.info(f"Run complete: {succeeded}/{attempted} succeeded, {empty} empty (no data), {failed} failed")
    if summary["errors"]:
        log.warning(f"Errors: {len(summary['errors'])}")
        for err in summary["errors"][:10]:
            log.warning(f"  • {err}")

    # Exit non-zero only on real failures (Upstash writes, network errors).
    # Empty results are not failures — they just mean low Google Trends volume.
    if failed > 0:
        sys.exit(2)


if __name__ == "__main__":
    main()
