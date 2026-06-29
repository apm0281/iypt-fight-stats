"""
Export all API data as static JSON files for GitHub Pages hosting.
Run once whenever new tournament data is scraped.

Output: frontend/data/
"""

import json
import re
import sys
from itertools import combinations
from pathlib import Path

import queries
from database import get_conn, normalize_name

OUT = Path(__file__).parent.parent / "frontend" / "data"


def slug(name: str) -> str:
    n = normalize_name(name)
    return re.sub(r"[^a-z0-9]+", "_", n).strip("_")


def write(rel_path: str, data) -> None:
    p = OUT / rel_path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"  {rel_path}")


def main():
    print("-- Years -----------------------------------------")
    years = queries.get_available_years()
    write("years.json", years)

    print("-- Rankings --------------------------------------")
    write("rankings/participants.json", queries.get_participant_rankings(None))
    write("rankings/teams.json", queries.get_team_rankings(None))
    for year in years:
        write(f"rankings/participants_{year}.json", queries.get_participant_rankings(year))
        write(f"rankings/teams_{year}.json", queries.get_team_rankings(year))

    print("-- Analytics -------------------------------------")
    write("analytics/problems.json", queries.get_problem_analytics(None))
    for year in years:
        write(f"analytics/problems_{year}.json", queries.get_problem_analytics(exact_year=year))
    write("analytics/role_stats.json", queries.get_role_stats())
    write("map.json", queries.get_map_data())

    print("-- Participants ----------------------------------")
    conn = get_conn()
    participant_rows = conn.execute(
        "SELECT DISTINCT name FROM participants ORDER BY name"
    ).fetchall()
    conn.close()

    search_index_p = []
    for i, row in enumerate(participant_rows):
        name = row["name"]
        profile = queries.get_participant_profile(name)
        if not profile:
            continue
        write(f"participants/{slug(name)}.json", profile)
        teams_set = {yd["team"] for yd in profile["years_data"] if yd.get("team")}
        search_index_p.append({
            "name": name,
            "slug": slug(name),
            "years": ", ".join(str(y) for y in profile["years"]),
            "teams": ", ".join(sorted(teams_set)),
        })
        if (i + 1) % 50 == 0:
            print(f"    {i + 1}/{len(participant_rows)} participants done")

    write("search/participants.json", search_index_p)
    print(f"  search index: {len(search_index_p)} participants")

    print("-- Teams -----------------------------------------")
    conn = get_conn()
    team_rows = conn.execute(
        "SELECT DISTINCT team_name FROM performances ORDER BY team_name"
    ).fetchall()
    conn.close()
    team_names = [r["team_name"] for r in team_rows]

    search_index_t = []
    for team_name in team_names:
        profile = queries.get_team_profile(team_name)
        if not profile:
            continue
        peers = queries.get_team_peers(team_name)
        intel = queries.get_team_problem_intelligence(team_name)
        trend = queries.get_team_trend(team_name)
        write(f"teams/{slug(team_name)}.json", {
            "profile": profile,
            "peers": peers,
            "intel": intel,
            "trend": round(trend, 4) if trend is not None else None,
        })
        search_index_t.append({
            "name": team_name,
            "slug": slug(team_name),
            "years": ", ".join(str(y) for y in profile["years"]),
        })

    write("search/teams.json", search_index_t)
    print(f"  search index: {len(search_index_t)} teams")

    print("-- Room matchup pairs ----------------------------")
    # Sort names so each pair has a canonical ordering
    sorted_teams = sorted(team_names)
    pairs = list(combinations(sorted_teams, 2))
    for i, (a, b) in enumerate(pairs):
        result = queries.get_room_matchup([a, b])
        key = f"{slug(a)}__vs__{slug(b)}"
        write(f"room_pairs/{key}.json", result)
        if (i + 1) % 100 == 0:
            print(f"    {i + 1}/{len(pairs)} pairs done")

    print(f"\nDone.")
    print(f"  {len(search_index_p)} participants")
    print(f"  {len(search_index_t)} teams")
    print(f"  {len(pairs)} room pairs")
    print(f"\nOutput: {OUT}")
    print("Now commit the frontend/ folder and push to GitHub Pages.")


if __name__ == "__main__":
    main()
