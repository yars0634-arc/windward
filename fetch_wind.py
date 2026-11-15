"""WINDWARD step 1: download hourly wind speed for each site from Open-Meteo.

Run:  python data/fetch_wind.py
Output: data/raw/<site_id>.csv with columns: time, wind_speed, variable

Uses the free Open-Meteo historical archive API (no key needed).
Wind speed is in m/s, times are local Kenyan time (Africa/Nairobi).
"""
import datetime as dt
import time

import pandas as pd
import requests

from sites_config import RAW_DIR, SITES

# ---- Settings -------------------------------------------------------------
API_URL = "https://archive-api.open-meteo.com/v1/archive"
YEARS_OF_DATA = 3
ARCHIVE_DELAY_DAYS = 7          # the archive lags a few days behind today
PREFERRED_VARIABLE = "wind_speed_100m"   # turbine hub height
FALLBACK_VARIABLE = "wind_speed_10m"     # used only if 100 m is unavailable
TIMEZONE = "Africa/Nairobi"
PAUSE_BETWEEN_REQUESTS_S = 2    # be polite to the free API


def download(site, variable, start, end):
    """Return a DataFrame (time, wind_speed) or None if the variable is empty."""
    params = {
        "latitude": site["lat"],
        "longitude": site["lon"],
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "hourly": variable,
        "wind_speed_unit": "ms",
        "timezone": TIMEZONE,
    }
    response = requests.get(API_URL, params=params, timeout=180)
    response.raise_for_status()
    hourly = response.json().get("hourly", {})
    values = hourly.get(variable)
    if not values or all(v is None for v in values):
        return None
    return pd.DataFrame({"time": hourly["time"], "wind_speed": values})


def main():
    end = dt.date.today() - dt.timedelta(days=ARCHIVE_DELAY_DAYS)
    start = end - dt.timedelta(days=365 * YEARS_OF_DATA)
    RAW_DIR.mkdir(exist_ok=True)
    print(f"Downloading {start} to {end} for {len(SITES)} sites...")

    for site in SITES:
        variable = PREFERRED_VARIABLE
        try:
            df = download(site, variable, start, end)
        except requests.RequestException as error:
            print(f"  {site['id']}: {variable} failed ({error})")
            df = None
        if df is None:
            variable = FALLBACK_VARIABLE
            print(f"  {site['id']}: falling back to {variable}")
            df = download(site, variable, start, end)
        if df is None:
            raise SystemExit(f"No wind data returned for {site['id']}")

        df["variable"] = variable
        path = RAW_DIR / f"{site['id']}.csv"
        df.to_csv(path, index=False)
        print(f"  {site['id']}: {len(df)} hours of {variable} "
              f"(mean {df['wind_speed'].mean():.1f} m/s) -> {path.name}")
        time.sleep(PAUSE_BETWEEN_REQUESTS_S)

    print("Done. Next: python data/train_model.py")


if __name__ == "__main__":
    main()
