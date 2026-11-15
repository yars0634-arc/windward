"""Shared settings for the WINDWARD data scripts.

The coordinates are grid points near Lake Turkana, northern Kenya.
The site NAMES are made up for the game (they are not real place names).
"""
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent
RAW_DIR = DATA_DIR / "raw"                      # one CSV per site goes here
GAME_DATA_DIR = DATA_DIR                      # forecasts.json + sites.json (same folder as the game)

SITES = [
    {"id": "north_shore",  "name": "North Shore",  "lat": 3.00, "lon": 36.55},
    {"id": "east_plateau", "name": "East Plateau", "lat": 2.90, "lon": 37.00},
    {"id": "central_gap",  "name": "Central Gap",  "lat": 2.75, "lon": 36.80},
    {"id": "south_ridge",  "name": "South Ridge",  "lat": 2.50, "lon": 36.60},
    {"id": "far_east",     "name": "Far East",     "lat": 2.55, "lon": 36.95},
]
