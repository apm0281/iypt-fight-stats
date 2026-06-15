import sqlite3
import json
import unicodedata
from pathlib import Path

DB_PATH = Path(__file__).parent / "iypt.db"


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS tournaments (
            id   INTEGER PRIMARY KEY,
            year INTEGER UNIQUE NOT NULL,
            name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS participants (
            id              INTEGER PRIMARY KEY,
            name            TEXT UNIQUE NOT NULL,
            name_normalized TEXT NOT NULL DEFAULT '',
            photo_url       TEXT,
            social_json     TEXT
        );

        CREATE TABLE IF NOT EXISTS performances (
            id             INTEGER PRIMARY KEY,
            participant_id INTEGER NOT NULL REFERENCES participants(id),
            tournament_id  INTEGER NOT NULL REFERENCES tournaments(id),
            team_name      TEXT    NOT NULL,
            round          INTEGER NOT NULL,
            fight_room     TEXT,
            stage_index    INTEGER NOT NULL,
            problem_number INTEGER,
            role           TEXT    NOT NULL,
            avg_score      REAL,
            z_avg_score    REAL,
            grades_json    TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS team_round_ranks (
            id            INTEGER PRIMARY KEY,
            tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
            round         INTEGER NOT NULL,
            team_name     TEXT    NOT NULL,
            rank          INTEGER,
            tsp           REAL,
            won           INTEGER
        );

        CREATE TABLE IF NOT EXISTS team_final_ranks (
            id            INTEGER PRIMARY KEY,
            tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
            team_name     TEXT    NOT NULL,
            final_rank    INTEGER NOT NULL,
            tsp           REAL,
            UNIQUE(tournament_id, team_name)
        );

        CREATE INDEX IF NOT EXISTS idx_perf_participant ON performances(participant_id);
        CREATE INDEX IF NOT EXISTS idx_perf_tournament  ON performances(tournament_id);
        CREATE INDEX IF NOT EXISTS idx_perf_role        ON performances(role);
        CREATE INDEX IF NOT EXISTS idx_part_normalized  ON participants(name_normalized);
        CREATE INDEX IF NOT EXISTS idx_tfr_tournament   ON team_final_ranks(tournament_id);
    """)
    conn.commit()

    # Migrations: add columns if they don't exist yet (for existing DBs)
    for col, coldef in [("photo_url", "TEXT"), ("social_json", "TEXT")]:
        try:
            conn.execute(f"ALTER TABLE participants ADD COLUMN {col} {coldef}")
            conn.commit()
        except Exception:
            pass  # column already exists

    conn.close()


def update_participant_social(name: str, photo_url: str | None, social_json: str | None):
    conn = get_conn()
    conn.execute(
        "UPDATE participants SET photo_url=?, social_json=? WHERE name=?",
        (photo_url, social_json, name),
    )
    conn.commit()
    conn.close()


def upsert_tournament(year: int, name: str) -> int:
    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO tournaments(year, name) VALUES (?, ?)", (year, name)
    )
    conn.commit()
    row = conn.execute("SELECT id FROM tournaments WHERE year=?", (year,)).fetchone()
    conn.close()
    return row["id"]


def normalize_name(name: str) -> str:
    """Lowercase + strip accents so 'Otavio' matches 'Otávio'."""
    nfkd = unicodedata.normalize("NFKD", name)
    return "".join(c for c in nfkd if not unicodedata.combining(c)).lower()


def upsert_participant(name: str) -> int:
    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO participants(name, name_normalized) VALUES (?, ?)",
        (name, normalize_name(name)),
    )
    conn.commit()
    row = conn.execute("SELECT id FROM participants WHERE name=?", (name,)).fetchone()
    conn.close()
    return row["id"]


def insert_performance(
    participant_id: int,
    tournament_id: int,
    team_name: str,
    round_num: int,
    fight_room: str,
    stage_index: int,
    problem_number: int | None,
    role: str,
    grades: list,
):
    avg = sum(g[1] for g in grades) / len(grades) if grades else None
    conn = get_conn()
    conn.execute(
        """INSERT INTO performances
           (participant_id, tournament_id, team_name, round, fight_room, stage_index,
            problem_number, role, avg_score, grades_json)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (
            participant_id,
            tournament_id,
            team_name,
            round_num,
            fight_room,
            stage_index,
            problem_number,
            role,
            avg,
            json.dumps(grades),
        ),
    )
    conn.commit()
    conn.close()


def insert_team_rank(tournament_id: int, round_num: int, team: str, rank: int | None, tsp: float | None, won: bool | None):
    conn = get_conn()
    conn.execute(
        """INSERT INTO team_round_ranks(tournament_id, round, team_name, rank, tsp, won)
           VALUES (?,?,?,?,?,?)""",
        (tournament_id, round_num, team, rank, tsp, int(won) if won is not None else None),
    )
    conn.commit()
    conn.close()


def compute_z_scores(tournament_id: int):
    """For each judge in a tournament, z-score their grades then update z_avg_score."""
    import math
    from collections import defaultdict

    conn = get_conn()
    rows = conn.execute(
        "SELECT id, grades_json FROM performances WHERE tournament_id=?",
        (tournament_id,),
    ).fetchall()

    judge_scores: dict[str, list[float]] = defaultdict(list)
    for row in rows:
        for judge, score in json.loads(row["grades_json"]):
            judge_scores[judge].append(float(score))

    judge_stats: dict[str, tuple[float, float]] = {}
    for judge, scores in judge_scores.items():
        mu = sum(scores) / len(scores)
        variance = sum((s - mu) ** 2 for s in scores) / len(scores)
        sigma = math.sqrt(variance) if variance > 0 else 1.0
        judge_stats[judge] = (mu, sigma)

    for row in rows:
        grades = json.loads(row["grades_json"])
        if not grades:
            continue
        z_vals = []
        for judge, score in grades:
            mu, sigma = judge_stats.get(judge, (0.0, 1.0))
            z_vals.append((float(score) - mu) / sigma)
        z_avg = sum(z_vals) / len(z_vals)
        conn.execute(
            "UPDATE performances SET z_avg_score=? WHERE id=?", (z_avg, row["id"])
        )
    conn.commit()
    conn.close()


def upsert_team_final_rank(tournament_id: int, team: str, final_rank: int, tsp: float | None):
    conn = get_conn()
    conn.execute(
        """INSERT OR REPLACE INTO team_final_ranks(tournament_id, team_name, final_rank, tsp)
           VALUES (?,?,?,?)""",
        (tournament_id, team, final_rank, tsp),
    )
    conn.commit()
    conn.close()


def clear_tournament(tournament_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM performances WHERE tournament_id=?", (tournament_id,))
    conn.execute("DELETE FROM team_round_ranks WHERE tournament_id=?", (tournament_id,))
    conn.execute("DELETE FROM team_final_ranks WHERE tournament_id=?", (tournament_id,))
    conn.commit()
    conn.close()
