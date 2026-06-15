@echo off
cd /d "%~dp0backend"

if not exist .venv (
    echo [1/3] Creating virtual environment...
    C:\Users\ampet\.local\bin\uv.exe venv .venv --python 3.14
    echo [2/3] Installing dependencies...
    C:\Users\ampet\.local\bin\uv.exe pip install -r requirements.txt --python .venv\Scripts\python.exe
    echo [3/3] Scraping IYPT data...
    .venv\Scripts\python.exe scraper.py
) else (
    echo Virtual environment already exists. Skipping setup.
    echo Run: .venv\Scripts\python.exe scraper.py  to re-scrape data.
)

echo.
echo Starting server at http://localhost:8000
.venv\Scripts\python.exe -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
