"""Creates SAMPLE forecasts.json + sites.json from SYNTHETIC wind.

Run:  python data/make_sample.py
This is only so the game runs before the real scripts have been run.
Every number here is made up. train_model.py overwrites the output.
"""
import numpy as np
import pandas as pd

from sites_config import SITES
from train_model import run_pipeline

SAMPLE_DAYS = 400
SEED = 7

# Made-up wind character per site: (mean m/s, daily swing m/s, gustiness)
SAMPLE_PROFILES = {
    "north_shore":  (10.5, 2.0, 2.6),   # strong but far from the villages
    "east_plateau": (7.5, 1.2, 1.0),    # weaker, steady, close
    "central_gap":  (8.5, 3.0, 2.8),    # close but gusty
    "south_ridge":  (9.8, 2.5, 1.6),
    "far_east":     (9.0, 1.5, 2.0),
}


def synthetic_series(mean, swing, gustiness, rng):
    hours = SAMPLE_DAYS * 24
    index = pd.date_range("2025-01-01", periods=hours, freq="h")
    hour = index.hour.to_numpy()
    day = index.dayofyear.to_numpy()
    daily_cycle = swing * np.cos(2 * np.pi * (hour - 22) / 24)   # windier at night
    season = 1.0 * np.sin(2 * np.pi * day / 365)
    noise = np.zeros(hours)                 # slow-moving random weather
    for i in range(1, hours):
        noise[i] = 0.95 * noise[i - 1] + rng.normal(0, 0.35 * gustiness)
    return pd.Series(np.clip(mean + daily_cycle + season + noise, 0, None), index=index)


def main():
    rng = np.random.default_rng(SEED)
    series = {s["id"]: synthetic_series(*SAMPLE_PROFILES[s["id"]], rng) for s in SITES}
    print("Building SAMPLE data from synthetic wind...")
    run_pipeline(series, sample=True, test_days=28, validation_days=60)


if __name__ == "__main__":
    main()
