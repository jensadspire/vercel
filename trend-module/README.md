# Trend Module — Industry Taxonomy

This folder contains the seed taxonomy for the trend module's industry-and-sub-category structure.

## Files

| File | Purpose |
|---|---|
| `industries.json` | The actual taxonomy data — list of industries with their config |
| `industries.schema.json` | JSON Schema that validates the structure of `industries.json` |
| `README.md` | This file |

## What's in `industries.json`

A list of 30 industries (28 enabled, 2 disabled). Each industry has:

- A `slug` (machine ID) and `name` (display label)
- A list of `sub_categories` — the actual search queries pytrends will track
- Calibration knobs: `trend_threshold_pct` (sensitivity) and `prospect_cap_per_quarter` (frequency)
- `seasonal_active_months` to skip dormant seasons
- `primary_countries` to scope pytrends queries
- An `enabled` master switch
- Free-text `notes` explaining why values were chosen

## How to use

The Python ingestion script (Phase 2 of the trend module — not yet built) will:

1. Load this file at startup
2. For each enabled industry × primary country × sub-category, query pytrends
3. Store time-series data in Upstash under `trend:query:{slug}:{country}` keys
4. Apply per-industry thresholds when detecting trend events
5. Apply per-industry caps when matching events to prospects

## When to edit this file

**Adding a new industry:** when prospect tagging discovers a category not covered here, add a new entry. Use the existing entries as templates.

**Refining a sub-category list:** after pytrends runs in observation mode for 1-2 weeks, you'll see which queries produce useful signal and which are noisy. Replace noisy queries with better alternatives.

**Tuning thresholds:** if you see too many false-positive trend events for an industry, raise its `trend_threshold_pct`. If you see too few real events, lower it. Tune iteratively, not all at once.

**Disabling an industry:** set `enabled: false` rather than deleting. Preserves the data for potential re-enabling later.

## Editing rules

- `slug` values are immutable once a prospect is tagged with them — changing a slug breaks all references
- `sub_categories` should stay ≤15 entries (otherwise pytrends rate-limiting becomes painful)
- Always validate after editing: see "Validation" section below

## Validation

Run from this folder:

```bash
python3 -c "
import json
from jsonschema import validate
data = json.load(open('industries.json'))
schema = json.load(open('industries.schema.json'))
validate(instance=data, schema=schema)
print('OK')
"
```

(Requires `pip install jsonschema --break-system-packages` on macOS.)

## Seeding strategy

The initial 30 industries are a starting point covering common e-commerce verticals. **They will not match your real prospect base perfectly.** The right way to evolve the taxonomy:

1. Tag your existing prospects (the ones already in `outreach/`-managed Google Sheet) with their industry slug from this file
2. Identify prospects that don't fit cleanly — they reveal taxonomy gaps
3. Add new industries to fill the gaps
4. Refine sub-category lists based on what pytrends actually surfaces as useful signal during Phase 2 observation

After ~50 tagged prospects, the taxonomy should stabilize. Don't try to predict every industry upfront.

## What's NOT in this file

- Industry-specific email templates (those live separately, in the outreach module)
- Trend event records (those live in Upstash at runtime)
- Prospect-to-industry mapping (lives in the Google Sheet)
- Source data from pytrends/RSS (lives in Upstash at runtime)

This file is config only. Operational data lives elsewhere.
