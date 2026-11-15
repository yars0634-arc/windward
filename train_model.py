"""WINDWARD step 2: train the wind forecast model and export JSON for the game.

Run:  python train_model.py      (after fetch_wind.py)
Output: forecasts.json and sites.json (next to this script)

For each site we train one Ridge regression that looks at the last 72 hours
of wind and predicts the next 24 hours. We compare it to a naive
"persistence" baseline (tomorrow = the last 24 hours).

Data is split by time, oldest to newest:
    TRAIN  |  VALIDATION (90 days)  |  TEST (most recent ~6 months)
The validation residuals give the P10 / P50 / P90 confidence band, so the
test set is never used to build the forecast it is scored on.
"""
import datetime as dt
import json

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from sites_config import GAME_DATA_DIR, RAW_DIR, SITES

# ---- Settings -------------------------------------------------------------
HISTORY_HOURS = 72        # how much past wind the model sees
HORIZON_HOURS = 24        # how far ahead it predicts
TEST_DAYS = 180           # most recent ~6 months, never trained on
VALIDATION_DAYS = 90      # used only for the confidence band
TRAIN_STRIDE_HOURS = 3    # start a training example every 3 hours
RIDGE_ALPHA = 10.0        # regularisation strength


def load_series(path):
    """Read one site's CSV into an hourly Series with gaps filled."""
    df = pd.read_csv(path, parse_dates=["time"])
    series = df.set_index("time")["wind_speed"].asfreq("h")
    return series.interpolate(limit_direction="both")


def make_examples(series, origin_positions):
    """Build model inputs/targets for forecasts starting at the given hours.

    Returns X (features), Y (next 24 h), persistence (previous 24 h).
    """
    values = series.to_numpy()
    times = series.index[origin_positions]
    history = np.stack([values[i - HISTORY_HOURS:i] for i in origin_positions])
    target = np.stack([values[i:i + HORIZON_HOURS] for i in origin_positions])
    persistence = history[:, -HORIZON_HOURS:]

    hour_angle = 2 * np.pi * times.hour.to_numpy() / 24
    day_angle = 2 * np.pi * times.dayofyear.to_numpy() / 365.25
    time_features = np.column_stack([
        np.sin(hour_angle), np.cos(hour_angle),
        np.sin(day_angle), np.cos(day_angle),
    ])
    return np.hstack([history, time_features]), target, persistence


def train_site(series, test_days=TEST_DAYS, validation_days=VALIDATION_DAYS):
    """Train + evaluate one site. Returns forecasts for every test day."""
    # Test days start at midnight so each forecast covers one calendar day.
    last_midnight = series.index[-1].normalize()
    test_start = last_midnight - pd.Timedelta(days=test_days)
    validation_start = test_start - pd.Timedelta(days=validation_days)

    positions = np.arange(HISTORY_HOURS, len(series) - HORIZON_HOURS + 1)
    forecast_end = series.index[positions + HORIZON_HOURS - 1]
    origin_time = series.index[positions]

    train_pos = positions[forecast_end < validation_start][::TRAIN_STRIDE_HOURS]
    val_pos = positions[(origin_time >= validation_start) & (forecast_end < test_start)]
    test_pos = positions[(origin_time >= test_start) & (origin_time.hour == 0)]

    X_train, Y_train, _ = make_examples(series, train_pos)
    X_val, Y_val, _ = make_examples(series, val_pos)
    X_test, Y_test, persistence = make_examples(series, test_pos)

    model = make_pipeline(StandardScaler(), Ridge(alpha=RIDGE_ALPHA))
    model.fit(X_train, Y_train)

    # Confidence band: how wrong was the model on validation, per hour ahead?
    residuals = Y_val - model.predict(X_val)
    q10, q50, q90 = np.percentile(residuals, [10, 50, 90], axis=0)

    prediction = model.predict(X_test)
    return {
        "dates": [t.strftime("%Y-%m-%d") for t in series.index[test_pos]],
        "actual": Y_test,
        "prediction": prediction,
        "p10": np.clip(prediction + q10, 0, None),
        "p50": np.clip(prediction + q50, 0, None),
        "p90": np.clip(prediction + q90, 0, None),
        "persistence": persistence,
    }


def run_pipeline(series_by_site, sample=False, **split):
    """Train every site, print the scores and write the two JSON files."""
    forecasts, site_rows = [], []
    model_errors, baseline_errors = [], []

    def rounded(row):
        return [round(float(v), 2) for v in row]

    for site in SITES:
        series = series_by_site[site["id"]]
        result = train_site(series, **split)
        model_errors.append(np.abs(result["prediction"] - result["actual"]))
        baseline_errors.append(np.abs(result["persistence"] - result["actual"]))

        for i, date in enumerate(result["dates"]):
            forecasts.append({
                "date": date,
                "site": site["id"],
                "actual": rounded(result["actual"][i]),
                "p10": rounded(result["p10"][i]),
                "p50": rounded(result["p50"][i]),
                "p90": rounded(result["p90"][i]),
                "persistence": rounded(result["persistence"][i]),
            })
        site_rows.append({
            "id": site["id"], "name": site["name"],
            "lat": site["lat"], "lon": site["lon"],
            "meanWind": round(float(series.mean()), 2),
            "windVariability": round(float(series.std()), 2),
        })
        print(f"  {site['id']:13s} model MAE {model_errors[-1].mean():.2f}  "
              f"persistence MAE {baseline_errors[-1].mean():.2f} m/s  "
              f"({len(result['dates'])} test days)")

    model_mae = float(np.concatenate(model_errors).mean())
    baseline_mae = float(np.concatenate(baseline_errors).mean())
    improvement = 100 * (baseline_mae - model_mae) / baseline_mae

    label = "SAMPLE - synthetic data, not real measurements" if sample else \
        "Real data: Open-Meteo historical archive"
    meta = {
        "sample": sample,
        "label": label,
        "generated": dt.date.today().isoformat(),
        "modelMAE": round(model_mae, 3),
        "persistenceMAE": round(baseline_mae, 3),
        "improvementPct": round(improvement, 1),
    }
    GAME_DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(GAME_DATA_DIR / "forecasts.json", "w") as f:
        json.dump({**meta, "forecasts": forecasts}, f, separators=(",", ":"))
    with open(GAME_DATA_DIR / "sites.json", "w") as f:
        json.dump({"sample": sample, "label": label, "sites": site_rows}, f, indent=1)

    print("\n===== PITCH SUMMARY" + (" (SAMPLE DATA)" if sample else "") + " =====")
    print(f"24-hour wind forecast, tested on unseen recent data")
    print(f"  Our model MAE:        {model_mae:.2f} m/s")
    print(f"  Persistence baseline: {baseline_mae:.2f} m/s")
    print(f"  Improvement:          {improvement:.1f}% lower error than the baseline")
    print(f"Wrote {len(forecasts)} forecasts to {GAME_DATA_DIR}")
    return meta


def main():
    series_by_site = {}
    for site in SITES:
        path = RAW_DIR / f"{site['id']}.csv"
        if not path.exists():
            raise SystemExit(f"Missing {path}. Run: python fetch_wind.py")
        series_by_site[site["id"]] = load_series(path)
    print("Training on real Open-Meteo data...")
    run_pipeline(series_by_site, sample=False)


if __name__ == "__main__":
    main()
