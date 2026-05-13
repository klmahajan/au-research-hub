"""
openalex-enricher.py
────────────────────
Takes faculty-list.json (your curated AU faculty list) and enriches each
person with their OpenAlex ID, publication count, citation count, and
research topics — then writes faculty-enriched.json, which au-faculty-network.html
can load directly.

USAGE:
  python3 openalex-enricher.py

REQUIREMENTS:
  pip install requests

HOW IT WORKS:
  For each faculty member in faculty-list.json:
    1. If openalex_id is already set → fetch directly by ID
    2. Otherwise → search OpenAlex by name + "American University" affiliation
    3. Save all enriched data to faculty-enriched.json

This script is free, uses the OpenAlex public API (no key required),
and runs in ~1–2 minutes for 100–300 faculty members.
"""

import json
import time
import sys
import urllib.parse
import urllib.request

AU_INSTITUTION_ID = "I181401687"
MAILTO = "research@american.edu"   # polite pool = faster, less throttled
API_BASE = "https://api.openalex.org"
INPUT_FILE = "faculty-list.json"
OUTPUT_FILE = "faculty-enriched.json"


def fetch(url: str) -> dict:
    """Simple HTTP GET with polite headers."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": f"AU-Faculty-Tool/1.0 (mailto:{MAILTO})"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def lookup_by_id(openalex_id: str) -> dict | None:
    """Fetch author data directly from OpenAlex by their ID."""
    short_id = openalex_id.split("/")[-1]   # e.g. A5012345678
    url = f"{API_BASE}/authors/{short_id}?select=id,display_name,works_count,cited_by_count,topics&mailto={MAILTO}"
    try:
        return fetch(url)
    except Exception as e:
        print(f"    ⚠️  Could not fetch by ID ({short_id}): {e}")
        return None


def search_by_name(name: str) -> dict | None:
    """Search OpenAlex for a faculty member by name + AU affiliation."""
    encoded_name = urllib.parse.quote(name)
    url = (
        f"{API_BASE}/authors"
        f"?filter=display_name.search:{encoded_name},"
        f"affiliations.institution.id:{AU_INSTITUTION_ID}"
        f"&sort=cited_by_count:desc"
        f"&per_page=3"
        f"&select=id,display_name,works_count,cited_by_count,topics"
        f"&mailto={MAILTO}"
    )
    try:
        data = fetch(url)
        results = data.get("results", [])
        if not results:
            # Fallback: search by name only (wider net)
            url2 = (
                f"{API_BASE}/authors"
                f"?filter=display_name.search:{encoded_name}"
                f"&sort=cited_by_count:desc"
                f"&per_page=3"
                f"&select=id,display_name,works_count,cited_by_count,topics"
                f"&mailto={MAILTO}"
            )
            data = fetch(url2)
            results = data.get("results", [])
        return results[0] if results else None
    except Exception as e:
        print(f"    ⚠️  Search failed for '{name}': {e}")
        return None


def enrich(person: dict, oa_data: dict) -> dict:
    """Merge OpenAlex data into a curated faculty entry."""
    enriched = dict(person)
    enriched["openalex_id"] = oa_data.get("id", person.get("openalex_id", ""))
    enriched["works_count"] = oa_data.get("works_count", 0)
    enriched["cited_by_count"] = oa_data.get("cited_by_count", 0)
    # Merge OpenAlex topics with manually curated research_areas
    oa_topics = [t["display_name"] for t in (oa_data.get("topics") or [])[:8]]
    manual = person.get("research_areas", [])
    combined = list(dict.fromkeys(manual + oa_topics))   # deduplicate, manual first
    enriched["research_areas"] = combined[:10]
    enriched["_oa_matched_name"] = oa_data.get("display_name", "")
    return enriched


def main():
    print(f"Loading {INPUT_FILE}…")
    with open(INPUT_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    faculty = data.get("faculty", [])
    if not faculty:
        print("No faculty entries found in faculty-list.json. Add entries and re-run.")
        sys.exit(1)

    print(f"Found {len(faculty)} faculty entries. Enriching via OpenAlex…\n")
    enriched_faculty = []
    not_found = []

    for i, person in enumerate(faculty):
        name = person.get("name", "Unknown")
        school = person.get("school", "")
        openalex_id = person.get("openalex_id", "").strip()

        print(f"[{i+1:>3}/{len(faculty)}] {name} ({school})")

        oa_data = None
        if openalex_id:
            print(f"         → fetching by ID…")
            oa_data = lookup_by_id(openalex_id)
        else:
            print(f"         → searching by name…")
            oa_data = search_by_name(name)

        if oa_data:
            matched = oa_data.get("display_name", "?")
            works = oa_data.get("works_count", 0)
            cites = oa_data.get("cited_by_count", 0)
            print(f"         ✅ Matched: {matched} | {works} works | {cites:,} citations")
            enriched_faculty.append(enrich(person, oa_data))
        else:
            print(f"         ❌ Not found in OpenAlex — keeping manual entry")
            enriched_faculty.append(dict(person))
            not_found.append(name)

        # Polite pause to avoid rate-limiting
        time.sleep(0.12)

    print(f"\n─────────────────────────────────────")
    print(f"Enriched: {len(enriched_faculty) - len(not_found)}/{len(faculty)}")
    if not_found:
        print(f"Not found ({len(not_found)}):")
        for n in not_found:
            print(f"  • {n}")
    print(f"  → Tip: for unmatched faculty, find their OpenAlex ID manually at")
    print(f"    https://openalex.org and paste it into faculty-list.json")

    output = {
        "_source": "Generated by openalex-enricher.py",
        "_input": INPUT_FILE,
        "_total": len(enriched_faculty),
        "_not_found_in_openalex": not_found,
        "faculty": enriched_faculty
    }

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nSaved → {OUTPUT_FILE}")
    print("Open au-faculty-network.html — it will auto-load this file if present.")


if __name__ == "__main__":
    main()
