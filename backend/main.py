from fastapi import FastAPI, HTTPException, Query
from typing import Optional
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
from pydantic import BaseModel
import json
import queries
from database import init_db, update_participant_social

app = FastAPI(title="IYPT Tracker")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND = Path(__file__).parent.parent / "frontend"


@app.on_event("startup")
def startup():
    init_db()


# ── Search ──────────────────────────────────────────────────────────────────

@app.get("/api/search/participants")
def search_participants(q: str = Query(..., min_length=2)):
    return queries.search_participants(q)


@app.get("/api/search/teams")
def search_teams(q: str = Query(..., min_length=2)):
    return queries.search_teams(q)


# ── Profiles ─────────────────────────────────────────────────────────────────

@app.get("/api/participant/{name}")
def participant_profile(name: str):
    profile = queries.get_participant_profile(name)
    if not profile:
        raise HTTPException(404, "Participant not found")
    return profile


@app.get("/api/team/{name}")
def team_profile(name: str):
    profile = queries.get_team_profile(name)
    if not profile:
        raise HTTPException(404, "Team not found")
    return profile


class SocialPayload(BaseModel):
    photo_url: Optional[str] = None
    social: Optional[dict] = None


@app.patch("/api/participant/{name}/social")
def update_social(name: str, payload: SocialPayload):
    profile = queries.get_participant_profile(name)
    if not profile:
        raise HTTPException(404, "Participant not found")
    social_json = json.dumps(payload.social) if payload.social else None
    update_participant_social(name, payload.photo_url, social_json)
    return {"ok": True}


# ── Intelligence & Map ────────────────────────────────────────────────────────

@app.get("/api/team/{name}/peers")
def team_peers(name: str, year: int = Query(None)):
    result = queries.get_team_peers(name, year)
    if not result:
        raise HTTPException(404, "Team not found")
    return result


@app.get("/api/team/{name}/intelligence")
def team_intelligence(name: str, min_year: Optional[int] = Query(None)):
    result = queries.get_team_problem_intelligence(name, min_year)
    if not result:
        raise HTTPException(404, "No problem data for this team")
    return result


@app.get("/api/analytics/problems")
def analytics_problems(year: Optional[int] = Query(None), min_year: Optional[int] = Query(None)):
    result = queries.get_problem_analytics(min_year=min_year, exact_year=year)
    if not result:
        raise HTTPException(404, "No problem data")
    return result


@app.get("/api/analytics/role-stats")
def analytics_role_stats():
    return queries.get_role_stats()


@app.get("/api/map/countries")
def map_countries():
    return queries.get_map_data()


# ── Rankings ─────────────────────────────────────────────────────────────────

@app.get("/api/rankings/years")
def ranking_years():
    return queries.get_available_years()


@app.get("/api/rankings/participants")
def ranking_participants(year: Optional[int] = Query(None)):
    return queries.get_participant_rankings(year)


@app.get("/api/rankings/teams")
def ranking_teams(year: Optional[int] = Query(None)):
    return queries.get_team_rankings(year)


# ── Room Matchup ─────────────────────────────────────────────────────────────

@app.get("/api/room-matchup")
def room_matchup(teams: str = Query(...)):
    team_list = [t.strip() for t in teams.split(",") if t.strip()]
    if len(team_list) < 2:
        raise HTTPException(400, "Provide at least 2 teams separated by commas")
    return queries.get_room_matchup(team_list)


# ── Comparisons ──────────────────────────────────────────────────────────────

@app.get("/api/compare/participants")
def compare_participants(a: str = Query(...), b: str = Query(...)):
    result = queries.compare_participants(a, b)
    if not result:
        raise HTTPException(404, "One or both participants not found")
    return result


@app.get("/api/compare/teams")
def compare_teams(a: str = Query(...), b: str = Query(...)):
    result = queries.compare_teams(a, b)
    if not result:
        raise HTTPException(404, "One or both teams not found")
    return result


# ── Frontend static files ─────────────────────────────────────────────────────

if FRONTEND.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND), name="static")

    @app.get("/")
    def root():
        return FileResponse(FRONTEND / "index.html")

    @app.get("/{path:path}")
    def catch_all(path: str):
        f = FRONTEND / path
        if f.exists() and f.is_file():
            return FileResponse(f)
        return FileResponse(FRONTEND / "index.html")
