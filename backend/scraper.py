"""
Fetches result dumps from cc.iypt.org and populates the SQLite database.

Primary source: YAML at /{slug}/resultdump/
Fallback:       HTML fight pages at /{slug}/{round}/{room}/ for any fight
                where the YAML has empty grades (happens in selective rounds).

Usage:
    python scraper.py                    # scrape all known tournaments
    python scraper.py iypt2022 iypt2024  # scrape specific ones
"""

import re
import sys
import yaml
import requests
from database import (
    init_db,
    upsert_tournament,
    upsert_participant,
    insert_performance,
    insert_team_rank,
    upsert_team_final_rank,
    compute_z_scores,
    clear_tournament,
)

TOURNAMENTS = {
    "iypt2017": 2017,
    "iypt2018": 2018,
    "iypt2019": 2019,
    "iypt2022": 2022,
    "iypt2023": 2023,
    "iypt2024": 2024,
    "iypt2025": 2025,
}
BASE_URL  = "https://cc.iypt.org/{slug}/resultdump/"
FIGHT_URL = "https://cc.iypt.org/{slug}/{round}/{room}/"
RANK_URL  = "https://cc.iypt.org/{slug}/rank/"
ROLES = ("Reporter", "Opponent", "Reviewer")


# ── HTML fight-page parser ────────────────────────────────────────────────────

def _strip_tags(html: str) -> str:
    return re.sub(r"<[^>]+>", "", html).strip()


def parse_fight_html(html: str) -> list[dict] | None:
    """
    Parse a fight result page.
    Returns a list of stage dicts (one per stage in the fight):
        {
          'countries': [reporter_country, opponent_country, reviewer_country],
          'persons':   {'Reporter': name, 'Opponent': name, 'Reviewer': name},
          'problem':   int | None,
          'grades':    {'Reporter': [[judge, score], ...], ...}
        }
    Returns None if the page can't be parsed.
    """
    tbody = re.search(r"<tbody>(.*?)</tbody>", html, re.DOTALL)
    if not tbody:
        return None

    rows = re.findall(r"<tr>(.*?)</tr>", tbody.group(1), re.DOTALL)
    if len(rows) < 4:
        return None

    # Row 0: stage headers — extract problem numbers.
    # Text looks like "Stage 1 6" or "Stage 2 10 14" after stripping tags.
    # Strip "Stage N" then take the first remaining integer as the presented problem.
    stage_problems: list[int | None] = []
    for th_html in re.findall(r"<th[^>]*>(.*?)</th>", rows[0], re.DOTALL)[1:]:
        text = re.sub(r"Stage\s*\d+", "", _strip_tags(th_html), flags=re.IGNORECASE)
        nums = [int(n) for n in re.findall(r"\b(\d+)\b", text) if 1 <= int(n) <= 17]
        stage_problems.append(nums[0] if nums else None)

    # Row 1: country headers.  Pattern: empty th, then 3 country ths per stage.
    country_ths = re.findall(r"<th[^>]*>(.*?)</th>", rows[1], re.DOTALL)
    countries = [_strip_tags(c) for c in country_ths[1:]]  # skip leading empty th
    countries = [c for c in countries if c]
    n_stages = len(countries) // 3
    if n_stages == 0:
        return None

    while len(stage_problems) < n_stages:
        stage_problems.append(None)

    stages = [
        {
            "countries": countries[i * 3 : i * 3 + 3],
            "persons":   {r: "" for r in ROLES},
            "problem":   stage_problems[i],
            "grades":    {r: [] for r in ROLES},
        }
        for i in range(n_stages)
    ]

    # Row 2: person-name abbreviations (e.g. "Y. Chung", "A. Huang").
    person_cells = re.findall(r"<(?:td|th)[^>]*>(.*?)</(?:td|th)>", rows[2], re.DOTALL)
    person_names = [_strip_tags(c).strip() for c in person_cells]
    if person_names and not person_names[0]:       # skip leading empty cell
        person_names = person_names[1:]
    for s_idx in range(n_stages):
        for r_idx, role in enumerate(ROLES):
            col = s_idx * 3 + r_idx
            if col < len(person_names) and person_names[col]:
                stages[s_idx]["persons"][role] = person_names[col]

    # Rows 3+: jury grade rows
    for row in rows[3:]:
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL)
        if not cells:
            continue

        judge = _strip_tags(cells[0])
        if not judge or re.search(r"average|factor|points", judge, re.IGNORECASE):
            continue

        grade_cells = cells[1:]
        for s_idx in range(n_stages):
            for r_idx, role in enumerate(ROLES):
                col = s_idx * 3 + r_idx
                if col >= len(grade_cells):
                    continue
                text = _strip_tags(grade_cells[col])
                try:
                    stages[s_idx]["grades"][role].append([judge, float(text)])
                except ValueError:
                    pass

    return stages


# ── HTML-only tournament scraper (for years with empty YAML, e.g. 2017) ────────

def fetch_overview_html(slug: str) -> str | None:
    url = f"https://cc.iypt.org/{slug}/"
    try:
        resp = requests.get(url, timeout=20)
        if resp.ok:
            return resp.text
    except Exception as e:
        print(f"    Warning: could not fetch {url}: {e}", flush=True)
    return None


def parse_overview_rooms(html: str, slug: str) -> dict[int, list[str]]:
    """Parse /{slug}/{round}/{room}/ links → {round_num: [room, ...]}."""
    pattern = rf"/{re.escape(slug)}/(\d+)/([a-z]+)/"
    result: dict[int, list[str]] = {}
    for round_str, room in re.findall(pattern, html):
        round_num = int(round_str)
        rooms = result.setdefault(round_num, [])
        if room not in rooms:
            rooms.append(room)
    return result


def scrape_tournament_html_only(slug: str, tournament_id: int):
    """
    Scrape a tournament that has no YAML data by fetching every fight page.
    Person names come from row 2 of each fight table (abbreviated form, e.g. 'Y. Chung').
    """
    print(f"  YAML empty — discovering rounds/rooms from overview page ...", flush=True)
    overview = fetch_overview_html(slug)
    if not overview:
        print(f"  Warning: could not fetch overview for {slug}", flush=True)
        return

    round_rooms = parse_overview_rooms(overview, slug)
    if not round_rooms:
        print(f"  Warning: no round/room links found in overview for {slug}", flush=True)
        return

    total_fights = 0
    for round_num in sorted(round_rooms.keys()):
        rooms = round_rooms[round_num]
        fights_this_round = 0
        for room in sorted(rooms):
            html = fetch_fight_html(slug, round_num, room)
            if not html:
                continue
            stages = parse_fight_html(html)
            if not stages:
                print(f"    Warning: could not parse {slug}/{round_num}/{room}/", flush=True)
                continue

            for stage_idx, stage in enumerate(stages):
                countries = stage["countries"]   # [reporter_cty, opponent_cty, reviewer_cty]
                for r_idx, role in enumerate(ROLES):
                    person = stage["persons"].get(role, "").strip()
                    team_name = countries[r_idx] if r_idx < len(countries) else ""
                    if not person:
                        continue
                    grades = stage["grades"].get(role, [])
                    participant_id = upsert_participant(person)
                    insert_performance(
                        participant_id=participant_id,
                        tournament_id=tournament_id,
                        team_name=team_name,
                        round_num=round_num,
                        fight_room=room,
                        stage_index=stage_idx,
                        problem_number=stage.get("problem"),
                        role=role,
                        grades=grades,
                    )
            fights_this_round += 1

        print(f"  Round {round_num}: {fights_this_round}/{len(rooms)} fights scraped", flush=True)
        total_fights += fights_this_round

    print(f"  HTML-only scrape done: {total_fights} fights for {slug}", flush=True)


# ── Judge-name abbreviation resolver ─────────────────────────────────────────

def _make_abbrev(full_name: str) -> str:
    """'Luis Guerrero' → 'L. Guerrero',  'Ghazanfar Hussain Sial' → 'G. Sial'"""
    parts = full_name.strip().split()
    return f"{parts[0][0]}. {parts[-1]}" if parts else full_name


def build_abbrev_map(known_full_names: set[str]) -> dict[str, str]:
    """
    Build abbreviated → full-name mapping from the set of known full names.
    Handles collisions: if two full names share the same abbreviation, the
    mapping is ambiguous and we keep the entry anyway (last writer wins) —
    it's the best we can do without extra context.
    """
    return {_make_abbrev(n): n for n in known_full_names}


def resolve_grades(grades: list, abbrev_map: dict) -> list:
    """Replace abbreviated judge names with full names where known."""
    return [[abbrev_map.get(j, j), s] for j, s in grades]


# ── Rank-page parser ──────────────────────────────────────────────────────────

def _parse_rank_table(table_html: str) -> list[list[str]]:
    """Extract cell text from all <td> rows in a table HTML fragment."""
    tbody = re.search(r"<tbody>(.*?)</tbody>", table_html, re.DOTALL)
    content = tbody.group(1) if tbody else table_html
    rows = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", content, re.DOTALL):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL)
        parsed = [_strip_tags(c).strip() for c in cells]
        if any(parsed):
            rows.append(parsed)
    return rows


def parse_rank_page(html: str) -> dict[str, list[list[str]]]:
    """
    Parse the official rank page at /{slug}/rank/.
    Returns a dict mapping section heading (e.g. 'Final Ranking', 'Round 5') to
    a list of rows, each row being a list of cell strings [rank, team, tsp/pts, ...].
    """
    result: dict[str, list[list[str]]] = {}
    parts = re.split(r"<h3[^>]*>(.*?)</h3>", html, flags=re.DOTALL)
    for i in range(1, len(parts), 2):
        heading = _strip_tags(parts[i]).strip()
        content = parts[i + 1] if i + 1 < len(parts) else ""
        table_match = re.search(r"<table[^>]*>(.*?)</table>", content, re.DOTALL)
        if table_match:
            rows = _parse_rank_table(table_match.group(0))
            if rows:
                result[heading] = rows
    return result


def fetch_rank_html(slug: str) -> str | None:
    url = RANK_URL.format(slug=slug)
    try:
        resp = requests.get(url, timeout=20)
        if resp.ok:
            return resp.text
    except Exception as e:
        print(f"    Warning: could not fetch {url}: {e}", flush=True)
    return None


def build_final_ranks(slug: str, tournament_id: int):
    """
    Fetch the official rank page and store the correct final ranking in team_final_ranks.
    PF teams get ranks 1..N (from 'Final Ranking' section), non-PF teams get N+1.. in
    TSP order (from the last regular round section, filtering out PF teams).
    """
    html = fetch_rank_html(slug)
    if not html:
        print(f"  Warning: could not fetch rank page for {slug}", flush=True)
        return

    sections = parse_rank_page(html)
    if not sections:
        print(f"  Warning: rank page for {slug} yielded no sections", flush=True)
        return

    final_section: list[list[str]] | None = None
    round_section: list[list[str]] | None = None

    for key, rows in sections.items():
        k = key.lower()
        if "final" in k and "ranking" in k:
            final_section = rows
        elif "round" in k:
            # Keep the section with the most rows (the full-field round, not the PF)
            if round_section is None or len(rows) > len(round_section):
                round_section = rows

    if not round_section:
        print(f"  Warning: no round section found in rank page for {slug}", flush=True)
        return

    # PF teams in official result order (row[1] = team name)
    pf_teams: list[str] = []
    if final_section:
        for row in final_section:
            if len(row) >= 2 and row[1]:
                pf_teams.append(row[1])
    pf_set = set(pf_teams)

    # Round section: build (team → tsp) from rows [rank, team, tsp, ...]
    round_teams: list[tuple[str, float | None]] = []
    for row in round_section:
        if len(row) >= 2 and row[1]:
            tsp = None
            if len(row) >= 3:
                try:
                    tsp = float(row[2])
                except ValueError:
                    pass
            round_teams.append((row[1], tsp))

    round_tsp: dict[str, float | None] = {t: tsp for t, tsp in round_teams}

    # Assign final ranks
    ranked: list[tuple[str, int, float | None]] = []
    for i, team in enumerate(pf_teams, 1):
        ranked.append((team, i, round_tsp.get(team)))
    next_rank = len(pf_teams) + 1
    for team, tsp in round_teams:
        if team not in pf_set:
            ranked.append((team, next_rank, tsp))
            next_rank += 1

    for team, rank, tsp in ranked:
        upsert_team_final_rank(tournament_id, team, rank, tsp)

    print(f"  Final ranks stored: {len(ranked)} teams for {slug}", flush=True)


# ── YAML fetch ────────────────────────────────────────────────────────────────

def fetch_yaml(slug: str) -> dict:
    url = BASE_URL.format(slug=slug)
    print(f"  Fetching {url} ...", flush=True)
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return yaml.safe_load(resp.text)


def fetch_fight_html(slug: str, round_num: int, room: str) -> str | None:
    url = FIGHT_URL.format(slug=slug, round=round_num, room=room.lower())
    try:
        resp = requests.get(url, timeout=20)
        if resp.ok:
            return resp.text
    except Exception as e:
        print(f"    Warning: could not fetch {url}: {e}", flush=True)
    return None


# ── Core scraper ──────────────────────────────────────────────────────────────

def scrape_tournament(slug: str, year: int):
    print(f"\n=== Scraping {slug} ({year}) ===")
    data = fetch_yaml(slug)

    tournament_id = upsert_tournament(year, slug)
    clear_tournament(tournament_id)

    rounds = sorted(k for k in data.keys() if isinstance(k, int))

    if not rounds:
        print(f"  YAML has no round data for {slug}, switching to HTML-only scrape ...", flush=True)
        scrape_tournament_html_only(slug, tournament_id)
        compute_z_scores(tournament_id)
        build_final_ranks(slug, tournament_id)
        return

    # Collect all judge full names from YAML (for later abbreviation resolution)
    known_judges: set[str] = set()
    for round_num in rounds:
        for fight in data[round_num].get("fights", []):
            for stage in fight.get("stages", []):
                for role_data in stage.get("teams", {}).values():
                    for g in role_data.get("grades", []):
                        if len(g) == 2:
                            known_judges.add(str(g[0]))

    abbrev_map = build_abbrev_map(known_judges)

    for round_num in rounds:
        round_data = data[round_num]
        fights = round_data.get("fights", [])
        ranks  = round_data.get("rank", [])

        for rank_entry in ranks:
            insert_team_rank(
                tournament_id=tournament_id,
                round_num=round_num,
                team=rank_entry.get("team", ""),
                rank=rank_entry.get("rank"),
                tsp=rank_entry.get("tsp"),
                won=rank_entry.get("all_won"),
            )

        for fight in fights:
            room   = fight.get("room", "")
            stages = fight.get("stages", [])

            # Check whether any stage in this fight lacks grades
            needs_html = any(
                not role_data.get("grades")
                for stage in stages
                for role_data in stage.get("teams", {}).values()
            )

            html_stages: list[dict] | None = None
            if needs_html and room:
                print(f"    Round {round_num} room {room}: grades missing, fetching HTML ...", flush=True)
                html = fetch_fight_html(slug, round_num, room)
                if html:
                    html_stages = parse_fight_html(html)
                    if html_stages:
                        # Update abbrev_map with any new judge abbreviations resolved
                        # (the HTML may introduce judges not in YAML — store as-is)
                        pass
                    else:
                        print(f"    Warning: could not parse HTML for round {round_num} room {room}", flush=True)

            for stage_idx, stage in enumerate(stages):
                problem_number = stage.get("presented")
                teams_in_stage = stage.get("teams", {})

                # Find the matching HTML stage by country alignment
                html_stage = None
                if html_stages:
                    yaml_countries = {
                        role: teams_in_stage[role]["team"]
                        for role in ROLES
                        if role in teams_in_stage
                    }
                    for hs in html_stages:
                        html_countries = dict(zip(ROLES, hs["countries"]))
                        if all(yaml_countries.get(r) == html_countries.get(r) for r in yaml_countries):
                            html_stage = hs
                            break

                for role, role_data in teams_in_stage.items():
                    if role not in ROLES:
                        continue

                    person    = role_data.get("person", "").strip()
                    team_name = role_data.get("team", "").strip()
                    if not person:
                        continue

                    grades_raw = role_data.get("grades", [])
                    grades = [[str(g[0]), float(g[1])] for g in grades_raw if len(g) == 2]

                    # Fall back to HTML grades when YAML is empty
                    if not grades and html_stage:
                        raw_html_grades = html_stage["grades"].get(role, [])
                        grades = resolve_grades(raw_html_grades, abbrev_map)
                        # Add any new full names discovered via HTML to the map
                        for judge, _ in grades:
                            known_judges.add(judge)
                        abbrev_map = build_abbrev_map(known_judges)

                    participant_id = upsert_participant(person)
                    insert_performance(
                        participant_id=participant_id,
                        tournament_id=tournament_id,
                        team_name=team_name,
                        round_num=round_num,
                        fight_room=room,
                        stage_index=stage_idx,
                        problem_number=problem_number,
                        role=role,
                        grades=grades,
                    )

        print(f"  Round {round_num}: {len(fights)} fights processed", flush=True)

    print(f"  Computing z-scores for {slug} ...", flush=True)
    compute_z_scores(tournament_id)
    print(f"  Building final ranks for {slug} ...", flush=True)
    build_final_ranks(slug, tournament_id)
    print(f"  Done: {slug}", flush=True)


def main():
    init_db()
    slugs = sys.argv[1:] if len(sys.argv) > 1 else list(TOURNAMENTS.keys())
    for slug in slugs:
        if slug not in TOURNAMENTS:
            print(f"Unknown tournament: {slug}. Known: {list(TOURNAMENTS.keys())}")
            continue
        scrape_tournament(slug, TOURNAMENTS[slug])
    print("\nAll done.")


if __name__ == "__main__":
    main()
