"""
Query helpers that build profile and comparison data from the database.
"""

import json
import math
from database import get_conn, normalize_name, update_participant_social


ROLES = ("Reporter", "Opponent", "Reviewer")

_ROLE_MEANS_CACHE: dict[str, float] | None = None


def _get_global_role_means() -> dict[str, float]:
    """Cached global mean z-score per role (used for role-adjustment)."""
    global _ROLE_MEANS_CACHE
    if _ROLE_MEANS_CACHE is not None:
        return _ROLE_MEANS_CACHE
    conn = get_conn()
    rows = conn.execute(
        """SELECT role, AVG(z_avg_score) AS mean_z
           FROM performances
           WHERE z_avg_score IS NOT NULL AND role IN ('Reporter','Opponent','Reviewer')
           GROUP BY role""",
    ).fetchall()
    conn.close()
    _ROLE_MEANS_CACHE = {r["role"]: r["mean_z"] for r in rows}
    return _ROLE_MEANS_CACHE


# ── Team trend (year-over-year improving/declining) ──────────────────────────

def _team_year_z_series(team_name: str) -> list[tuple[int, float]]:
    """Per-year average z_avg_score for a team, across all members/roles/fights
    that year (the same granular per-performance z-score used elsewhere)."""
    conn = get_conn()
    rows = conn.execute(
        """SELECT t.year, AVG(pf.z_avg_score) AS avg_z
           FROM performances pf
           JOIN tournaments t ON t.id = pf.tournament_id
           WHERE pf.team_name = ? AND pf.z_avg_score IS NOT NULL
           GROUP BY t.year
           ORDER BY t.year""",
        (team_name,),
    ).fetchall()
    conn.close()
    return [(r["year"], r["avg_z"]) for r in rows if r["avg_z"] is not None]


def _weighted_slope(points: list[tuple[int, float]], ref_year: int, half_life: float = 2.0) -> float | None:
    """Weighted least-squares slope (z-score change per year). Weight decays
    exponentially with distance from ref_year (half_life years = weight halves).
    Gaps between years are fine. Returns None with fewer than 3 data points."""
    if len(points) < 3:
        return None
    decay = math.log(2) / half_life
    weights = [math.exp(-decay * (ref_year - yr)) for yr, _ in points]
    sw = sum(weights)
    mean_x = sum(w * yr for w, (yr, _z) in zip(weights, points)) / sw
    mean_y = sum(w * z for w, (_yr, z) in zip(weights, points)) / sw
    num = sum(w * (yr - mean_x) * (z - mean_y) for w, (yr, z) in zip(weights, points))
    den = sum(w * (yr - mean_x) ** 2 for w, (yr, _z) in zip(weights, points))
    if den == 0:
        return None
    return num / den


def get_team_trend(team_name: str, ref_year: int | None = None) -> float | None:
    """Slope of the team's weighted-regression z-score trend (z-score change per
    year). None if the team has fewer than 3 years of data."""
    if ref_year is None:
        ref_year = max(get_available_years())
    return _weighted_slope(_team_year_z_series(team_name), ref_year)


_ALL_TRENDS_CACHE: dict[str, float] | None = None
_TREND_STD_CACHE: float | None = None


def _get_all_team_trends() -> dict[str, float]:
    """Trend value for every team with enough data. Cached — this is the
    population used to judge how 'significant' a trend gap between two teams is."""
    global _ALL_TRENDS_CACHE
    if _ALL_TRENDS_CACHE is not None:
        return _ALL_TRENDS_CACHE
    conn = get_conn()
    rows = conn.execute("SELECT DISTINCT team_name FROM performances").fetchall()
    conn.close()
    ref_year = max(get_available_years())
    trends = {}
    for r in rows:
        t = get_team_trend(r["team_name"], ref_year)
        if t is not None:
            trends[r["team_name"]] = t
    _ALL_TRENDS_CACHE = trends
    return trends


def _get_trend_std() -> float:
    """Population std dev of all teams' trends — the reference scale for 'how
    big a trend difference is unusual'."""
    global _TREND_STD_CACHE
    if _TREND_STD_CACHE is not None:
        return _TREND_STD_CACHE
    vals = list(_get_all_team_trends().values())
    n = len(vals)
    if n < 2:
        _TREND_STD_CACHE = 1.0
        return _TREND_STD_CACHE
    mean = sum(vals) / n
    var = sum((x - mean) ** 2 for x in vals) / (n - 1)
    _TREND_STD_CACHE = math.sqrt(var) if var > 0 else 1.0
    return _TREND_STD_CACHE


def _logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def _sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))


def _blend_trend_into_probability(p_hist: float, trend_a: float | None, trend_b: float | None) -> float:
    """Nudge the historical head-to-head probability toward the team with the
    better recent trend — but only as much as the trend gap is genuinely unusual
    relative to the population of all teams' trends (continuous, saturating,
    capped). No trend data on either side => no change."""
    if trend_a is None or trend_b is None:
        return p_hist
    sigma = _get_trend_std()
    diff = trend_a - trend_b
    z_diff = abs(diff) / (sigma * math.sqrt(2)) if sigma > 0 else 0.0
    weight = (z_diff ** 2) / (z_diff ** 2 + 1.5 ** 2)
    max_shift = 0.6  # logit units; caps the swing from trend alone
    sign = 1 if diff > 0 else (-1 if diff < 0 else 0)
    adjustment = sign * weight * max_shift
    return _sigmoid(_logit(p_hist) + adjustment)


def search_participants(q: str, limit: int = 15) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT p.name,
                  GROUP_CONCAT(DISTINCT t.year) AS years,
                  GROUP_CONCAT(DISTINCT pf.team_name) AS teams
           FROM participants p
           JOIN performances pf ON pf.participant_id = p.id
           JOIN tournaments t   ON t.id = pf.tournament_id
           WHERE p.name_normalized LIKE ?
           GROUP BY p.id
           ORDER BY p.name
           LIMIT ?""",
        (f"%{normalize_name(q)}%", limit),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def search_teams(q: str, limit: int = 15) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT pf.team_name AS name,
                  GROUP_CONCAT(DISTINCT t.year ORDER BY t.year) AS years
           FROM performances pf
           JOIN tournaments t ON t.id = pf.tournament_id
           WHERE pf.team_name LIKE ? COLLATE NOCASE
           GROUP BY pf.team_name
           ORDER BY pf.team_name
           LIMIT ?""",
        (f"%{q}%", limit),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _fetch_social(participant_name: str) -> tuple[str | None, str | None]:
    conn = get_conn()
    row = conn.execute(
        "SELECT photo_url, social_json FROM participants WHERE name = ? COLLATE NOCASE",
        (participant_name,),
    ).fetchone()
    conn.close()
    if not row:
        return None, None
    return row["photo_url"], row["social_json"]


def _fetch_performances(participant_name: str) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT pf.*, t.year, t.id AS tournament_id
           FROM performances pf
           JOIN participants p ON p.id = pf.participant_id
           JOIN tournaments t  ON t.id = pf.tournament_id
           WHERE p.name = ? COLLATE NOCASE
           ORDER BY t.year, pf.round, pf.stage_index""",
        (participant_name,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _quartile_rank(participant_name: str, tournament_id: int) -> dict:
    """
    Compute quartile position among all participants in the same tournament.
    Uses overall avg_score across all roles.
    """
    conn = get_conn()
    # All participants in tournament with their average score
    rows = conn.execute(
        """SELECT p.name, AVG(pf.avg_score) AS overall_avg
           FROM performances pf
           JOIN participants p ON p.id = pf.participant_id
           WHERE pf.tournament_id = ?
           GROUP BY p.id""",
        (tournament_id,),
    ).fetchall()
    conn.close()

    scores = sorted([r["overall_avg"] for r in rows if r["overall_avg"] is not None], reverse=True)
    target = next(
        (r["overall_avg"] for r in rows if r["name"].lower() == participant_name.lower()),
        None,
    )
    if target is None or not scores:
        return {"quartile": None, "percentile": None, "rank": None, "total": len(scores)}

    rank = sum(1 for s in scores if s > target) + 1
    percentile = round(100 * (1 - rank / len(scores)), 1)
    quartile = 4 - int(percentile // 25)  # Q1=top, Q4=bottom
    quartile = max(1, min(4, quartile))
    return {
        "quartile": quartile,
        "percentile": percentile,
        "rank": rank,
        "total": len(scores),
    }


def get_participant_profile(name: str) -> dict | None:
    perfs = _fetch_performances(name)
    if not perfs:
        return None

    # Group by tournament year
    by_year: dict[int, list[dict]] = {}
    for p in perfs:
        by_year.setdefault(p["year"], []).append(p)

    years_data = []
    all_role_avgs: dict[str, list[float]] = {r: [] for r in ROLES}
    all_z_avgs: dict[str, list[float]] = {r: [] for r in ROLES}
    role_means = _get_global_role_means()
    year_global_zs: list[float] = []

    def mean(vals: list[float]) -> float | None:
        return round(sum(vals) / len(vals), 3) if vals else None

    for year, year_perfs in sorted(by_year.items()):
        tournament_id = year_perfs[0]["tournament_id"]

        role_avgs: dict[str, list[float]] = {r: [] for r in ROLES}
        z_avgs: dict[str, list[float]] = {r: [] for r in ROLES}
        teams_in_year = set()

        role_total: dict[str, int] = {r: 0 for r in ROLES}  # all appearances, incl. no-grade

        for p in year_perfs:
            role = p["role"]
            if role in ROLES:
                role_total[role] += 1
                if p["avg_score"] is not None:
                    role_avgs[role].append(p["avg_score"])
                    all_role_avgs[role].append(p["avg_score"])
                if p["z_avg_score"] is not None:
                    z_avgs[role].append(p["z_avg_score"])
                    all_z_avgs[role].append(p["z_avg_score"])
            teams_in_year.add(p["team_name"])

        adj_zs_y = [z - role_means.get(r, 0.0) for r in ROLES for z in z_avgs[r]]
        n_y = len(adj_zs_y)
        if n_y > 0:
            year_global_zs.append(sum(adj_zs_y) / n_y * n_y / (n_y + 3.5))

        quartile_info = _quartile_rank(name, tournament_id)

        years_data.append({
            "year": year,
            "team": ", ".join(sorted(teams_in_year)),
            "role_avg": {r: mean(v) for r, v in role_avgs.items()},
            "role_z_avg": {r: mean(v) for r, v in z_avgs.items()},
            "performances_count": role_total,
            "scored_count": {r: len(v) for r, v in role_avgs.items()},
            "quartile": quartile_info,
            "fights": [
                {
                    "round": pf["round"],
                    "fight_room": pf["fight_room"],
                    "role": pf["role"],
                    "avg_score": round(pf["avg_score"], 2) if pf["avg_score"] is not None else None,
                    "z_avg_score": round(pf["z_avg_score"], 3) if pf["z_avg_score"] is not None else None,
                    "problem_number": pf["problem_number"],
                }
                for pf in year_perfs
                if pf["role"] in ROLES
            ],
        })

    overall_role_avg = {r: mean(v) for r, v in all_role_avgs.items()}
    overall_z_avg = {r: mean(v) for r, v in all_z_avgs.items()}

    all_z_flat = [z for v in all_z_avgs.values() for z in v]
    overall_z_score = mean(all_z_flat)

    all_adj_z_flat = [z - role_means.get(r, 0.0) for r in ROLES for z in all_z_avgs[r]]
    role_adj_z_score = mean(all_adj_z_flat)
    global_z = round(sum(year_global_zs) / len(year_global_zs), 4) if year_global_zs else None

    photo_url, social_json = _fetch_social(name)

    rm_rounded = {k: round(v, 4) for k, v in role_means.items()}
    return {
        "name": name,
        "years": [y["year"] for y in years_data],
        "years_data": years_data,
        "overall_role_avg": overall_role_avg,
        "overall_z_avg": overall_z_avg,
        "overall_z_score": overall_z_score,
        "role_adj_z_score": role_adj_z_score,
        "global_z": global_z,
        "role_means": rm_rounded,
        "photo_url": photo_url,
        "social": json.loads(social_json) if social_json else {},
    }


def get_team_profile(team_name: str) -> dict | None:
    conn = get_conn()
    # Get all team members and their performances grouped by tournament
    rows = conn.execute(
        """SELECT pf.team_name, p.name, pf.tournament_id, t.year, pf.role,
                  AVG(pf.avg_score) AS avg_score, AVG(pf.z_avg_score) AS z_avg_score,
                  COUNT(*) AS n_perfs
           FROM performances pf
           JOIN participants p ON p.id = pf.participant_id
           JOIN tournaments t  ON t.id = pf.tournament_id
           WHERE pf.team_name = ? COLLATE NOCASE
           GROUP BY p.name, pf.tournament_id, pf.role
           ORDER BY t.year, p.name""",
        (team_name,),
    ).fetchall()

    # Team final ranks
    rank_rows = conn.execute(
        """SELECT t.year, tfr.final_rank AS rank, tfr.tsp
           FROM team_final_ranks tfr
           JOIN tournaments t ON t.id = tfr.tournament_id
           WHERE tfr.team_name = ? COLLATE NOCASE
           ORDER BY t.year""",
        (team_name,),
    ).fetchall()
    conn.close()

    if not rows:
        return None

    # Use the canonical casing stored in the DB, not the raw search input
    canonical_name = rows[0]["team_name"]

    final_ranks: dict[int, dict] = {}
    for r in rank_rows:
        final_ranks[r["year"]] = {"rank": r["rank"], "tsp": r["tsp"]}

    by_year: dict[int, dict] = {}
    for r in rows:
        yr = r["year"]
        if yr not in by_year:
            by_year[yr] = {"members": {}, "final_rank": final_ranks.get(yr)}
        member = r["name"]
        if member not in by_year[yr]["members"]:
            by_year[yr]["members"][member] = {}
        by_year[yr]["members"][member][r["role"]] = {
            "avg": round(r["avg_score"], 3) if r["avg_score"] else None,
            "z_avg": round(r["z_avg_score"], 3) if r["z_avg_score"] else None,
            "n": r["n_perfs"],
        }

    years_data = []
    for year, ydata in sorted(by_year.items()):
        years_data.append({
            "year": year,
            "members": ydata["members"],
            "final_rank": ydata["final_rank"],
        })

    return {
        "team": canonical_name,
        "years": sorted(by_year.keys()),
        "years_data": years_data,
    }


def compare_participants(name_a: str, name_b: str) -> dict | None:
    profile_a = get_participant_profile(name_a)
    profile_b = get_participant_profile(name_b)
    if not profile_a or not profile_b:
        return None

    def winner(a_val, b_val):
        if a_val is None and b_val is None:
            return None
        if a_val is None:
            return "b"
        if b_val is None:
            return "a"
        if a_val > b_val:
            return "a"
        if b_val > a_val:
            return "b"
        return "tie"

    comparison = {
        "overall_z_score": winner(
            profile_a["overall_z_score"], profile_b["overall_z_score"]
        ),
        "role_avg": {
            role: winner(profile_a["overall_role_avg"].get(role), profile_b["overall_role_avg"].get(role))
            for role in ROLES
        },
        "role_z_avg": {
            role: winner(profile_a["overall_z_avg"].get(role), profile_b["overall_z_avg"].get(role))
            for role in ROLES
        },
    }

    return {"a": profile_a, "b": profile_b, "winner": comparison}


def compare_teams(team_a: str, team_b: str) -> dict | None:
    profile_a = get_team_profile(team_a)
    profile_b = get_team_profile(team_b)
    if not profile_a or not profile_b:
        return None
    return {"a": profile_a, "b": profile_b}


def get_team_problem_intelligence(team_name: str, min_year: int | None = None) -> dict | None:
    from problems_data import PROBLEMS, CATEGORIES
    from stats import one_sample_t_test

    conn = get_conn()
    sql = """SELECT pf.problem_number, t.year, pf.role, pf.z_avg_score
             FROM performances pf
             JOIN tournaments t ON t.id = pf.tournament_id
             WHERE pf.team_name = ? COLLATE NOCASE
               AND pf.role IN ('Reporter', 'Opponent')
               AND pf.z_avg_score IS NOT NULL"""
    params: list = [team_name]
    if min_year is not None:
        sql += " AND t.year >= ?"
        params.append(min_year)
    rows = conn.execute(sql, params).fetchall()
    conn.close()

    if not rows:
        return None

    # Collect z-scores per (category, role) and per role overall
    from collections import defaultdict
    cat_role: dict[str, dict[str, list[float]]] = {
        cat: {"Reporter": [], "Opponent": []} for cat in CATEGORIES
    }
    role_all: dict[str, list[float]] = {"Reporter": [], "Opponent": []}

    for r in [dict(row) for row in rows]:
        prob = PROBLEMS.get((r["year"], r["problem_number"]))
        if not prob:
            continue
        cat = prob["category"]
        role = r["role"]
        z = r["z_avg_score"]
        cat_role[cat][role].append(z)
        role_all[role].append(z)

    reporter_mu = sum(role_all["Reporter"]) / len(role_all["Reporter"]) if role_all["Reporter"] else None
    opponent_mu = sum(role_all["Opponent"]) / len(role_all["Opponent"]) if role_all["Opponent"] else None

    def _sig(p):
        if p is None:
            return None
        if p < 0.001:
            return "***"
        if p < 0.01:
            return "**"
        if p < 0.05:
            return "*"
        return None

    result = []
    for cat in CATEGORIES:
        rep_scores = cat_role[cat]["Reporter"]
        opp_scores = cat_role[cat]["Opponent"]

        rep_mean = round(sum(rep_scores) / len(rep_scores), 3) if rep_scores else None
        opp_mean = round(sum(opp_scores) / len(opp_scores), 3) if opp_scores else None

        _, rep_p = one_sample_t_test(rep_scores, reporter_mu) if reporter_mu is not None else (None, None)
        _, opp_p = one_sample_t_test(opp_scores, opponent_mu) if opponent_mu is not None else (None, None)

        result.append({
            "category": cat,
            "reporter_count": len(rep_scores),
            "opponent_count": len(opp_scores),
            "reporter_avg_z": rep_mean,
            "opponent_avg_z": opp_mean,
            "reporter_sig": _sig(rep_p),
            "opponent_sig": _sig(opp_p),
            "reporter_p": rep_p,
            "opponent_p": opp_p,
        })

    return {
        "team": team_name,
        "min_year": min_year,
        "reporter_overall_z": round(reporter_mu, 3) if reporter_mu is not None else None,
        "opponent_overall_z": round(opponent_mu, 3) if opponent_mu is not None else None,
        "categories": result,
    }


def get_problem_analytics(min_year: int | None = None, exact_year: int | None = None) -> dict | None:
    """
    For each problem that has z-score data, return:
    - times_presented (Reporter role)
    - avg_score, avg_z, std_z
    - category, name, year appearances
    """
    from problems_data import PROBLEMS, CATEGORIES
    conn = get_conn()
    sql = """SELECT pf.problem_number, t.year,
                    AVG(pf.avg_score) AS avg_score,
                    AVG(pf.z_avg_score) AS avg_z,
                    COUNT(*) AS n
             FROM performances pf
             JOIN tournaments t ON t.id = pf.tournament_id
             WHERE pf.role = 'Reporter'
               AND pf.avg_score IS NOT NULL
               AND pf.z_avg_score IS NOT NULL"""
    params: list = []
    if exact_year is not None:
        sql += " AND t.year = ?"
        params.append(exact_year)
    elif min_year is not None:
        sql += " AND t.year >= ?"
        params.append(min_year)
    sql += " GROUP BY pf.problem_number, t.year ORDER BY t.year, pf.problem_number"
    rows = conn.execute(sql, params).fetchall()

    # Also get opponent data
    opp_sql = """SELECT pf.problem_number, t.year,
                         AVG(pf.avg_score) AS avg_score,
                         AVG(pf.z_avg_score) AS avg_z,
                         COUNT(*) AS n
                  FROM performances pf
                  JOIN tournaments t ON t.id = pf.tournament_id
                  WHERE pf.role = 'Opponent'
                    AND pf.avg_score IS NOT NULL
                    AND pf.z_avg_score IS NOT NULL"""
    opp_params: list = []
    if exact_year is not None:
        opp_sql += " AND t.year = ?"
        opp_params.append(exact_year)
    elif min_year is not None:
        opp_sql += " AND t.year >= ?"
        opp_params.append(min_year)
    opp_sql += " GROUP BY pf.problem_number, t.year ORDER BY t.year, pf.problem_number"
    opp_rows = conn.execute(opp_sql, opp_params).fetchall()
    conn.close()

    if not rows:
        return None

    from collections import defaultdict
    # Aggregate by (year, problem_number)
    by_prob: dict[tuple, dict] = defaultdict(lambda: {"rep_scores": [], "rep_zs": [], "opp_scores": [], "opp_zs": [], "n_rep": 0, "n_opp": 0})
    for r in [dict(x) for x in rows]:
        key = (r["year"], r["problem_number"])
        by_prob[key]["rep_scores"].append(r["avg_score"])
        by_prob[key]["rep_zs"].append(r["avg_z"])
        by_prob[key]["n_rep"] += r["n"]
    for r in [dict(x) for x in opp_rows]:
        key = (r["year"], r["problem_number"])
        by_prob[key]["opp_scores"].append(r["avg_score"])
        by_prob[key]["opp_zs"].append(r["avg_z"])
        by_prob[key]["n_opp"] += r["n"]

    result = []
    for (year, prob_num), d in sorted(by_prob.items()):
        prob = PROBLEMS.get((year, prob_num))
        if not prob:
            continue
        rep_avg_z = sum(d["rep_zs"]) / len(d["rep_zs"]) if d["rep_zs"] else None
        rep_avg_score = sum(d["rep_scores"]) / len(d["rep_scores"]) if d["rep_scores"] else None
        opp_avg_z = sum(d["opp_zs"]) / len(d["opp_zs"]) if d["opp_zs"] else None
        result.append({
            "year": year,
            "problem_number": prob_num,
            "name": prob["name"],
            "category": prob["category"],
            "n_presented": d["n_rep"],
            "n_challenged": d["n_opp"],
            "rep_avg_score": round(rep_avg_score, 3) if rep_avg_score is not None else None,
            "rep_avg_z": round(rep_avg_z, 3) if rep_avg_z is not None else None,
            "opp_avg_z": round(opp_avg_z, 3) if opp_avg_z is not None else None,
        })

    # Category summaries
    cat_data: dict[str, dict] = defaultdict(lambda: {"n_presented": 0, "rep_zs": [], "opp_zs": []})
    for p in result:
        cat = p["category"]
        cat_data[cat]["n_presented"] += p["n_presented"]
        if p["rep_avg_z"] is not None:
            cat_data[cat]["rep_zs"].append(p["rep_avg_z"])
        if p["opp_avg_z"] is not None:
            cat_data[cat]["opp_zs"].append(p["opp_avg_z"])

    # Compute role baselines so we can show relative-to-role z
    all_rep_zs = [z for p in result if p["rep_avg_z"] is not None for z in [p["rep_avg_z"]]]
    all_opp_zs = [z for p in result if p["opp_avg_z"] is not None for z in [p["opp_avg_z"]]]
    rep_baseline = sum(all_rep_zs) / len(all_rep_zs) if all_rep_zs else 0.0
    opp_baseline = sum(all_opp_zs) / len(all_opp_zs) if all_opp_zs else 0.0

    categories = []
    for cat in CATEGORIES:
        d = cat_data[cat]
        rep_mu = sum(d["rep_zs"]) / len(d["rep_zs"]) if d["rep_zs"] else None
        opp_mu = sum(d["opp_zs"]) / len(d["opp_zs"]) if d["opp_zs"] else None
        categories.append({
            "category": cat,
            "n_presented": d["n_presented"],
            "rep_avg_z": round(rep_mu, 3) if rep_mu is not None else None,
            "opp_avg_z": round(opp_mu, 3) if opp_mu is not None else None,
            # relative = how this category compares to the overall role average
            "rep_rel_z": round(rep_mu - rep_baseline, 3) if rep_mu is not None else None,
            "opp_rel_z": round(opp_mu - opp_baseline, 3) if opp_mu is not None else None,
        })

    # Also tag each problem with its relative z
    for p in result:
        p["rep_rel_z"] = round(p["rep_avg_z"] - rep_baseline, 3) if p["rep_avg_z"] is not None else None
        p["opp_rel_z"] = round(p["opp_avg_z"] - opp_baseline, 3) if p["opp_avg_z"] is not None else None

    return {
        "min_year": min_year,
        "rep_baseline_z": round(rep_baseline, 3),
        "opp_baseline_z": round(opp_baseline, 3),
        "problems": result,
        "categories": categories,
    }


def get_role_stats() -> dict:
    """
    Returns per-role z-score statistics (mean, std, distribution) and a one-way
    ANOVA result to test whether Reporter / Opponent / Reviewer means differ
    significantly. Also produces a top-30 ranking comparison (current vs role-adj).
    """
    import math
    from stats import one_way_anova
    from collections import defaultdict

    conn = get_conn()
    rows = conn.execute(
        """SELECT p.name, pf.role, pf.z_avg_score
           FROM performances pf
           JOIN participants p ON p.id = pf.participant_id
           WHERE pf.z_avg_score IS NOT NULL
             AND pf.role IN ('Reporter', 'Opponent', 'Reviewer')""",
    ).fetchall()
    conn.close()

    roles = ("Reporter", "Opponent", "Reviewer")
    by_role: dict[str, list[float]] = {r: [] for r in roles}
    by_participant: dict[str, dict[str, list[float]]] = defaultdict(
        lambda: {r: [] for r in roles}
    )

    for row in [dict(x) for x in rows]:
        role, z, name = row["role"], row["z_avg_score"], row["name"]
        if role in roles:
            by_role[role].append(z)
            by_participant[name][role].append(z)

    # Per-role descriptive stats + histogram
    role_means: dict[str, float] = {}
    role_stats_list = []
    for role in roles:
        zs = by_role[role]
        n = len(zs)
        if n == 0:
            role_means[role] = 0.0
            role_stats_list.append({"role": role, "n": 0, "mean": None, "std": None, "histogram": []})
            continue
        mean = sum(zs) / n
        role_means[role] = mean
        std = math.sqrt(sum((z - mean) ** 2 for z in zs) / (n - 1)) if n > 1 else 0.0
        bins, lo, hi = 30, -3.0, 3.0
        width = (hi - lo) / bins
        counts = [0] * bins
        for z in zs:
            idx = max(0, min(bins - 1, int((z - lo) / width)))
            counts[idx] += 1
        role_stats_list.append({
            "role": role,
            "n": n,
            "mean": round(mean, 4),
            "std": round(std, 4),
            "histogram": [
                {"bin_center": round(lo + (i + 0.5) * width, 2), "count": counts[i]}
                for i in range(bins)
            ],
        })

    f_stat, p_val = one_way_anova([by_role[r] for r in roles])

    # Per-participant ranking comparison: current adj_z vs role-adjusted adj_z
    ranked_current = []
    ranked_adj = []
    for name, role_zs in by_participant.items():
        all_zs = [z for r in roles for z in role_zs[r]]
        n = len(all_zs)
        if n < 2:
            continue
        current_z = sum(all_zs) / n
        adj_zs = [z - role_means[r] for r in roles for z in role_zs[r]]
        role_adj_z = sum(adj_zs) / len(adj_zs)
        shrinkage = n / (n + 5)
        ranked_current.append({"name": name, "z": round(current_z * shrinkage, 4), "n": n})
        ranked_adj.append({"name": name, "z": round(role_adj_z * shrinkage, 4), "n": n})

    ranked_current.sort(key=lambda x: -(x["z"] or 0))
    ranked_adj.sort(key=lambda x: -(x["z"] or 0))
    rank_adj_map = {x["name"]: (i + 1, x["z"]) for i, x in enumerate(ranked_adj)}

    top30 = []
    for i, x in enumerate(ranked_current[:30]):
        name = x["name"]
        adj_rank, adj_z = rank_adj_map.get(name, (None, None))
        top30.append({
            "name": name,
            "current_rank": i + 1,
            "current_z": x["z"],
            "adj_rank": adj_rank,
            "adj_z": adj_z,
            "rank_change": (i + 1) - adj_rank if adj_rank is not None else None,
        })

    return {
        "roles": role_stats_list,
        "role_means": {k: round(v, 4) for k, v in role_means.items()},
        "anova": {"f": f_stat, "p": p_val},
        "ranking_comparison": top30,
        "total_participants": len(ranked_current),
    }


def get_map_data() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT pf.team_name AS team,
                  ROUND(AVG(pf.z_avg_score), 3) AS overall_z,
                  ROUND(AVG(pf.avg_score),   3) AS overall_avg,
                  COUNT(DISTINCT pf.tournament_id) AS n_years
           FROM performances pf
           WHERE pf.z_avg_score IS NOT NULL
           GROUP BY pf.team_name
           ORDER BY overall_z DESC NULLS LAST""",
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_available_years() -> list[int]:
    conn = get_conn()
    rows = conn.execute("SELECT year FROM tournaments ORDER BY year").fetchall()
    conn.close()
    return [r["year"] for r in rows]


def _compute_global_z_per_participant(year_filter: int | None = None) -> dict[str, float]:
    """Global Z = mean over years of [role_adj_z_y × n_y/(n_y+3.5)]."""
    rm = _get_global_role_means()
    rep_m, opp_m, rev_m = rm.get("Reporter", 0.0), rm.get("Opponent", 0.0), rm.get("Reviewer", 0.0)
    conn = get_conn()
    sql = (
        "SELECT p.name, t.year,"
        " AVG(pf.z_avg_score - CASE pf.role"
        " WHEN 'Reporter' THEN ? WHEN 'Opponent' THEN ? WHEN 'Reviewer' THEN ? ELSE 0 END) AS adj_z_y,"
        " COUNT(*) AS n_y"
        " FROM performances pf"
        " JOIN participants p ON p.id = pf.participant_id"
        " JOIN tournaments t ON t.id = pf.tournament_id"
        " WHERE pf.z_avg_score IS NOT NULL AND pf.role IN ('Reporter','Opponent','Reviewer')"
    )
    params: list = [rep_m, opp_m, rev_m]
    if year_filter is not None:
        sql += " AND t.year = ?"
        params.append(year_filter)
    sql += " GROUP BY p.id, t.year"
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    from collections import defaultdict
    by_p: dict[str, list[float]] = defaultdict(list)
    for r in [dict(x) for x in rows]:
        n_y, z_y = r["n_y"], r["adj_z_y"]
        if z_y is not None and n_y > 0:
            by_p[r["name"]].append(z_y * n_y / (n_y + 3.5))
    return {name: round(sum(v) / len(v), 4) for name, v in by_p.items() if v}


def get_participant_rankings(year: int | None) -> list[dict]:
    rm = _get_global_role_means()
    rep_m = rm.get("Reporter", 0.0)
    opp_m = rm.get("Opponent", 0.0)
    rev_m = rm.get("Reviewer", 0.0)
    role_adj_expr = (
        "ROUND(AVG(pf.z_avg_score - CASE pf.role "
        "WHEN 'Reporter' THEN ? WHEN 'Opponent' THEN ? WHEN 'Reviewer' THEN ? ELSE 0 END), 3)"
        " AS role_adj_z"
    )
    conn = get_conn()
    if year is None:
        rows = conn.execute(
            f"""SELECT
                   p.name,
                   GROUP_CONCAT(DISTINCT pf.team_name)                                AS team,
                   ROUND(AVG(pf.avg_score),   3)                                      AS overall_avg,
                   ROUND(AVG(pf.z_avg_score), 3)                                      AS overall_z,
                   {role_adj_expr},
                   ROUND(AVG(CASE WHEN pf.role='Reporter' THEN pf.avg_score   END),3) AS reporter_avg,
                   ROUND(AVG(CASE WHEN pf.role='Opponent' THEN pf.avg_score   END),3) AS opponent_avg,
                   ROUND(AVG(CASE WHEN pf.role='Reviewer' THEN pf.avg_score   END),3) AS reviewer_avg,
                   ROUND(AVG(CASE WHEN pf.role='Reporter' THEN pf.z_avg_score END),3) AS reporter_z,
                   ROUND(AVG(CASE WHEN pf.role='Opponent' THEN pf.z_avg_score END),3) AS opponent_z,
                   ROUND(AVG(CASE WHEN pf.role='Reviewer' THEN pf.z_avg_score END),3) AS reviewer_z,
                   COUNT(CASE WHEN pf.role='Reporter' THEN 1 END)                     AS n_reporter,
                   COUNT(CASE WHEN pf.role='Opponent' THEN 1 END)                     AS n_opponent,
                   COUNT(CASE WHEN pf.role='Reviewer' THEN 1 END)                     AS n_reviewer,
                   COUNT(DISTINCT pf.tournament_id)                                   AS n_years
               FROM performances pf
               JOIN participants p ON p.id = pf.participant_id
               GROUP BY p.id
               ORDER BY role_adj_z DESC NULLS LAST""",
            (rep_m, opp_m, rev_m),
        ).fetchall()
    else:
        rows = conn.execute(
            f"""SELECT
                   p.name,
                   pf.team_name                                                        AS team,
                   ROUND(AVG(pf.avg_score),   3)                                      AS overall_avg,
                   ROUND(AVG(pf.z_avg_score), 3)                                      AS overall_z,
                   {role_adj_expr},
                   ROUND(AVG(CASE WHEN pf.role='Reporter' THEN pf.avg_score   END),3) AS reporter_avg,
                   ROUND(AVG(CASE WHEN pf.role='Opponent' THEN pf.avg_score   END),3) AS opponent_avg,
                   ROUND(AVG(CASE WHEN pf.role='Reviewer' THEN pf.avg_score   END),3) AS reviewer_avg,
                   ROUND(AVG(CASE WHEN pf.role='Reporter' THEN pf.z_avg_score END),3) AS reporter_z,
                   ROUND(AVG(CASE WHEN pf.role='Opponent' THEN pf.z_avg_score END),3) AS opponent_z,
                   ROUND(AVG(CASE WHEN pf.role='Reviewer' THEN pf.z_avg_score END),3) AS reviewer_z,
                   COUNT(CASE WHEN pf.role='Reporter' THEN 1 END)                     AS n_reporter,
                   COUNT(CASE WHEN pf.role='Opponent' THEN 1 END)                     AS n_opponent,
                   COUNT(CASE WHEN pf.role='Reviewer' THEN 1 END)                     AS n_reviewer,
                   1                                                                   AS n_years
               FROM performances pf
               JOIN participants p ON p.id = pf.participant_id
               JOIN tournaments  t ON t.id = pf.tournament_id
               WHERE t.year = ?
               GROUP BY p.id, pf.team_name
               ORDER BY role_adj_z DESC NULLS LAST""",
            (rep_m, opp_m, rev_m, year),
        ).fetchall()
    conn.close()
    global_z_map = _compute_global_z_per_participant(year)
    result = [dict(r) for r in rows]
    for r in result:
        r["global_z"] = global_z_map.get(r["name"])
    result.sort(key=lambda x: -(x["global_z"] if x["global_z"] is not None else -999))
    return result


def get_team_rankings(year: int | None) -> list[dict]:
    conn = get_conn()

    if year is None:
        rank_rows = conn.execute(
            """SELECT tfr.team_name,
                      MIN(tfr.final_rank) AS best_rank,
                      ROUND(SUM(tfr.tsp), 1) AS total_tsp,
                      COUNT(DISTINCT tfr.tournament_id) AS n_years
               FROM team_final_ranks tfr
               GROUP BY tfr.team_name""",
        ).fetchall()

        perf_rows = conn.execute(
            """SELECT
                   pf.team_name                                                        AS team,
                   ROUND(AVG(pf.avg_score),   3)                                      AS overall_avg,
                   ROUND(AVG(pf.z_avg_score), 3)                                      AS overall_z,
                   ROUND(AVG(CASE WHEN pf.role='Reporter' THEN pf.avg_score   END),3) AS reporter_avg,
                   ROUND(AVG(CASE WHEN pf.role='Opponent' THEN pf.avg_score   END),3) AS opponent_avg,
                   ROUND(AVG(CASE WHEN pf.role='Reviewer' THEN pf.avg_score   END),3) AS reviewer_avg,
                   ROUND(AVG(CASE WHEN pf.role='Reporter' THEN pf.z_avg_score END),3) AS reporter_z,
                   ROUND(AVG(CASE WHEN pf.role='Opponent' THEN pf.z_avg_score END),3) AS opponent_z,
                   ROUND(AVG(CASE WHEN pf.role='Reviewer' THEN pf.z_avg_score END),3) AS reviewer_z,
                   COUNT(DISTINCT pf.participant_id)                                   AS n_members
               FROM performances pf
               GROUP BY pf.team_name""",
        ).fetchall()
        conn.close()

        ranks = {
            r["team_name"]: {"final_rank": r["best_rank"], "final_tsp": r["total_tsp"], "n_years": r["n_years"]}
            for r in rank_rows
        }
    else:
        rank_rows = conn.execute(
            """SELECT tfr.team_name, tfr.final_rank, tfr.tsp AS final_tsp
               FROM team_final_ranks tfr
               JOIN tournaments t ON t.id = tfr.tournament_id
               WHERE t.year = ?""",
            (year,),
        ).fetchall()

        perf_rows = conn.execute(
            """SELECT
                   pf.team_name                                                        AS team,
                   ROUND(AVG(pf.avg_score),   3)                                      AS overall_avg,
                   ROUND(AVG(pf.z_avg_score), 3)                                      AS overall_z,
                   ROUND(AVG(CASE WHEN pf.role='Reporter' THEN pf.avg_score   END),3) AS reporter_avg,
                   ROUND(AVG(CASE WHEN pf.role='Opponent' THEN pf.avg_score   END),3) AS opponent_avg,
                   ROUND(AVG(CASE WHEN pf.role='Reviewer' THEN pf.avg_score   END),3) AS reviewer_avg,
                   ROUND(AVG(CASE WHEN pf.role='Reporter' THEN pf.z_avg_score END),3) AS reporter_z,
                   ROUND(AVG(CASE WHEN pf.role='Opponent' THEN pf.z_avg_score END),3) AS opponent_z,
                   ROUND(AVG(CASE WHEN pf.role='Reviewer' THEN pf.z_avg_score END),3) AS reviewer_z,
                   COUNT(DISTINCT pf.participant_id)                                   AS n_members
               FROM performances pf
               JOIN tournaments t ON t.id = pf.tournament_id
               WHERE t.year = ?
               GROUP BY pf.team_name""",
            (year,),
        ).fetchall()
        conn.close()

        ranks = {
            r["team_name"]: {"final_rank": r["final_rank"], "final_tsp": r["final_tsp"], "n_years": 1}
            for r in rank_rows
        }

    result = []
    seen_teams: set[str] = set()
    for r in perf_rows:
        entry = dict(r)
        entry.update(ranks.get(r["team"], {"final_rank": None, "final_tsp": None, "n_years": None}))
        result.append(entry)
        seen_teams.add(r["team"])

    # For year-specific view, include teams with rank data but no performances yet
    if year is not None:
        for r in rank_rows:
            if r["team_name"] not in seen_teams:
                result.append({
                    "team": r["team_name"],
                    "overall_avg": None, "overall_z": None,
                    "reporter_avg": None, "opponent_avg": None, "reviewer_avg": None,
                    "reporter_z": None, "opponent_z": None, "reviewer_z": None,
                    "n_members": None,
                    "final_rank": r["final_rank"],
                    "final_tsp": r["final_tsp"],
                    "n_years": 1,
                })

    result.sort(key=lambda x: (
        x["overall_z"] is None,
        -(x["overall_z"] or 0),
        x["final_rank"] or 9999,
    ))
    return result


def get_room_matchup(teams: list[str]) -> dict:
    from itertools import combinations
    from collections import defaultdict

    if len(teams) < 2:
        return {"teams": teams, "matchups": []}

    conn = get_conn()
    norm_input = [normalize_name(t) for t in teams]

    # All distinct (tournament_id, round, fight_room, team_name) rows
    rows = conn.execute(
        "SELECT DISTINCT tournament_id, round, fight_room, team_name FROM performances WHERE fight_room IS NOT NULL"
    ).fetchall()

    # Map each fight key to: all team names, and which of our input teams are present
    all_fight_teams: dict[tuple, set] = defaultdict(set)   # key -> ALL teams in fight
    fight_our_teams: dict[tuple, set] = defaultdict(set)   # key -> our teams in fight
    team_name_map: dict[str, str] = {}  # normalized -> canonical name in DB

    for r in rows:
        key = (r["tournament_id"], r["round"], r["fight_room"])
        tn = r["team_name"]
        all_fight_teams[key].add(tn)
        tn_norm = normalize_name(tn)
        if tn_norm in norm_input:
            fight_our_teams[key].add(tn)
            team_name_map[tn_norm] = tn

    # Relevant fights: those where 2+ of our teams appear
    relevant_keys = [k for k, v in fight_our_teams.items() if len(v) >= 2]

    # For each relevant fight, compute team fight scores, ranks, and per-role scores
    fight_data: dict[tuple, dict] = {}
    for key in relevant_keys:
        tid, rnd, room = key
        score_rows = conn.execute(
            """SELECT team_name, AVG(avg_score) AS fight_score
               FROM performances
               WHERE tournament_id=? AND round=? AND fight_room=? AND avg_score IS NOT NULL
               GROUP BY team_name""",
            (tid, rnd, room),
        ).fetchall()
        role_rows = conn.execute(
            """SELECT team_name, role, AVG(avg_score) AS role_score
               FROM performances
               WHERE tournament_id=? AND round=? AND fight_room=? AND avg_score IS NOT NULL
                 AND role IN ('Reporter','Opponent','Reviewer')
               GROUP BY team_name, role""",
            (tid, rnd, room),
        ).fetchall()
        year_row = conn.execute("SELECT year FROM tournaments WHERE id=?", (tid,)).fetchone()
        year = year_row["year"] if year_row else None

        scores = sorted([(r["team_name"], r["fight_score"]) for r in score_rows], key=lambda x: -(x[1] or 0))
        rank_map = {name: i + 1 for i, (name, _) in enumerate(scores)}
        score_map = {name: score for name, score in scores}

        role_score_map: dict[str, dict[str, float]] = {}
        for rr in role_rows:
            role_score_map.setdefault(rr["team_name"], {})[rr["role"]] = rr["role_score"]

        fight_data[key] = {
            "year": year,
            "round": rnd,
            "fight_room": room,
            "rank_map": rank_map,
            "score_map": score_map,
            "role_score_map": role_score_map,
            "all_teams": [name for name, _ in scores],
        }

    conn.close()

    # Build pairwise matchups
    matchups = []
    for i, j in combinations(range(len(teams)), 2):
        norm_a, norm_b = norm_input[i], norm_input[j]
        canonical_a = team_name_map.get(norm_a, teams[i])
        canonical_b = team_name_map.get(norm_b, teams[j])

        encounters = []
        role_wins = {canonical_a: {r: 0 for r in ROLES}, canonical_b: {r: 0 for r in ROLES}}
        for key, fdata in fight_data.items():
            our_norms = {normalize_name(t) for t in fdata["all_teams"] if normalize_name(t) in norm_input}
            if norm_a not in our_norms or norm_b not in our_norms:
                continue

            a_in_fight = next((t for t in fdata["all_teams"] if normalize_name(t) == norm_a), None)
            b_in_fight = next((t for t in fdata["all_teams"] if normalize_name(t) == norm_b), None)
            if not a_in_fight or not b_in_fight:
                continue

            third = [t for t in fdata["all_teams"] if normalize_name(t) not in [norm_a, norm_b]]

            a_score = fdata["score_map"].get(a_in_fight)
            b_score = fdata["score_map"].get(b_in_fight)
            encounters.append({
                "year": fdata["year"],
                "round": fdata["round"],
                "fight_room": fdata["fight_room"],
                "team_a_rank": fdata["rank_map"].get(a_in_fight),
                "team_b_rank": fdata["rank_map"].get(b_in_fight),
                "team_a_score": round(a_score, 2) if a_score is not None else None,
                "team_b_score": round(b_score, 2) if b_score is not None else None,
                "third_team": third[0] if third else None,
                "third_rank": fdata["rank_map"].get(third[0]) if third else None,
            })

            # Per-role win tally (Reporter/Opponent/Reviewer), independent of overall fight rank
            rsm = fdata.get("role_score_map", {})
            for role in ROLES:
                sa = rsm.get(a_in_fight, {}).get(role)
                sb = rsm.get(b_in_fight, {}).get(role)
                if sa is None or sb is None:
                    continue
                if sa > sb:
                    role_wins[canonical_a][role] += 1
                elif sb > sa:
                    role_wins[canonical_b][role] += 1

        encounters.sort(key=lambda x: (x["year"] or 0, x["round"]))

        a_ranks = [e["team_a_rank"] for e in encounters if e["team_a_rank"] is not None]
        b_ranks = [e["team_b_rank"] for e in encounters if e["team_b_rank"] is not None]

        # Laplace-smoothed probability: regresses toward 50% on small samples
        # a_above_b = fights where A finished ahead of B (lower rank number = better)
        ranked_pairs = [(e["team_a_rank"], e["team_b_rank"]) for e in encounters
                        if e["team_a_rank"] is not None and e["team_b_rank"] is not None]
        n_ranked = len(ranked_pairs)
        a_above_b = sum(1 for ra, rb in ranked_pairs if ra < rb)
        p_a_historical = round((a_above_b + 1) / (n_ranked + 2), 3)  # Laplace: (wins+1)/(n+2)

        # Year-over-year trend, blended in only when the gap is genuinely unusual
        trend_a = get_team_trend(canonical_a)
        trend_b = get_team_trend(canonical_b)
        p_a = round(_blend_trend_into_probability(p_a_historical, trend_a, trend_b), 3)

        matchups.append({
            "team_a": canonical_a,
            "team_b": canonical_b,
            "n_encounters": len(encounters),
            "team_a_avg_rank": round(sum(a_ranks) / len(a_ranks), 2) if a_ranks else None,
            "team_b_avg_rank": round(sum(b_ranks) / len(b_ranks), 2) if b_ranks else None,
            "a_above_b": a_above_b,
            "n_ranked": n_ranked,
            "p_a_wins": p_a,
            "p_b_wins": round(1 - p_a, 3),
            "p_a_wins_historical": p_a_historical,
            "p_b_wins_historical": round(1 - p_a_historical, 3),
            "trend_a": round(trend_a, 4) if trend_a is not None else None,
            "trend_b": round(trend_b, 4) if trend_b is not None else None,
            "role_wins": role_wins,
            "encounters": encounters,
        })

    canonical_teams = [team_name_map.get(n, t) for n, t in zip(norm_input, teams)]
    return {"teams": canonical_teams, "matchups": matchups}


def get_team_peers(team_name: str, year: int | None = None) -> dict | None:
    """
    Return 5 teams immediately above and below this team by avg z-score
    in the given year (defaults to the team's most recent year).
    """
    conn = get_conn()

    if year is None:
        row = conn.execute(
            """SELECT MAX(t.year) AS last_year
               FROM performances pf
               JOIN tournaments t ON t.id = pf.tournament_id
               WHERE pf.team_name = ? COLLATE NOCASE""",
            (team_name,),
        ).fetchone()
        if not row or not row["last_year"]:
            conn.close()
            return None
        year = row["last_year"]

    rows = conn.execute(
        """SELECT pf.team_name,
                  ROUND(AVG(pf.z_avg_score), 3) AS team_z,
                  ROUND(AVG(pf.avg_score),   3) AS team_avg,
                  ROUND(AVG(CASE WHEN pf.role='Reporter' THEN pf.avg_score END), 3) AS reporter_avg,
                  ROUND(AVG(CASE WHEN pf.role='Opponent' THEN pf.avg_score END), 3) AS opponent_avg,
                  ROUND(AVG(CASE WHEN pf.role='Reviewer' THEN pf.avg_score END), 3) AS reviewer_avg,
                  tfr.final_rank
           FROM performances pf
           JOIN tournaments t ON t.id = pf.tournament_id
           LEFT JOIN team_final_ranks tfr
                  ON tfr.tournament_id = t.id
                 AND tfr.team_name = pf.team_name COLLATE NOCASE
           WHERE t.year = ? AND pf.z_avg_score IS NOT NULL
           GROUP BY pf.team_name
           ORDER BY team_z DESC""",
        (year,),
    ).fetchall()
    conn.close()

    if not rows:
        return None

    teams = [dict(r) for r in rows]
    our_idx = next(
        (i for i, t in enumerate(teams)
         if normalize_name(t["team_name"]) == normalize_name(team_name)),
        None,
    )
    if our_idx is None:
        return None

    our = teams[our_idx]
    above = list(reversed(teams[max(0, our_idx - 10) : our_idx]))
    below = teams[our_idx + 1 : our_idx + 6]

    return {
        "team": our["team_name"],
        "team_z": our["team_z"],
        "team_avg": our["team_avg"],
        "reporter_avg": our["reporter_avg"],
        "opponent_avg": our["opponent_avg"],
        "reviewer_avg": our["reviewer_avg"],
        "final_rank": our["final_rank"],
        "rank_in_field": our_idx + 1,
        "total_teams": len(teams),
        "year": year,
        "above": above,
        "below": below,
    }
