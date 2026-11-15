// WINDWARD blackout risk + recommendations. Pure functions, no rendering.
// The rules are deliberately simple and transparent: no second model.

import {
  simulateDay, turbineCost, turbinePowerMW, MAX_TURBINES_PER_SITE,
  BATTERY_START_MWH,
} from './sim.js';

// ---- Tuning constants ----
export const SHORTFALL_THRESHOLD_MWH = 0.05; // smaller gaps don't count as "short"
export const REPEAT_WINDOW_DAYS = 3;         // look back this many days...
export const REPEAT_SHORT_DAYS = 2;          // ...and suggest building if this many were short

/** Pick one band (p10 / p50 / p90 / persistence / actual) for every site. */
export function pickWind(forecastBySite, key) {
  const wind = {};
  for (const siteId in forecastBySite) wind[siteId] = forecastBySite[siteId][key];
  return wind;
}

/**
 * Blackout risk for one day.
 * Runs wind + hydro vs demand (no battery, no diesel) three times:
 * low wind (P10), expected wind (P50), high wind (P90).
 */
export function assessRisk({ forecastBySite, turbines, reservoirFraction }) {
  const shortfall = (key) => simulateDay({
    windBySite: pickWind(forecastBySite, key), turbines, reservoirFraction, useBattery: false,
  }).totals;

  const p10 = shortfall('p10');
  const p50 = shortfall('p50');
  const p90 = shortfall('p90');
  const isShort = (t) => t.rawShortfallMWh > SHORTFALL_THRESHOLD_MWH;

  let level = 'LOW';
  if (isShort(p90)) level = 'HIGH';                       // short even with strong wind
  else if (isShort(p10) || isShort(p50)) level = 'MEDIUM'; // short only if wind is weak

  return {
    level,
    shortfallMWh: { p10: p10.rawShortfallMWh, p50: p50.rawShortfallMWh, p90: p90.rawShortfallMWh },
    expectedShortfallMWh: p50.rawShortfallMWh,
    expectedShortfallPct: (100 * p50.rawShortfallMWh) / p50.demandMWh,
  };
}

/** Best place to add a turbine: most expected power per $ among sites with room. */
export function bestBuildSite(sites, turbines) {
  let best = null;
  let bestValue = -1;
  for (const site of sites) {
    if ((turbines[site.id] || 0) >= MAX_TURBINES_PER_SITE) continue;
    const value = turbinePowerMW(site.meanWind) / turbineCost(site);
    if (value > bestValue) { best = site; bestValue = value; }
  }
  return best;
}

/**
 * Turn a risk rating into a recommended action.
 * @returns { text, batteryMode, dieselReserved, buildAdvice }
 */
export function recommend({
  risk, forecastBySite, turbines, reservoirFraction, batterySoc, recentShortDays = 0, sites = [],
}) {
  // Play it safe: would the battery alone cover a LOW-wind (P10) day in this mode?
  const batteryCovers = (batteryMode) => simulateDay({
    windBySite: pickWind(forecastBySite, 'p10'), turbines, reservoirFraction,
    batterySoc, batteryMode,
  }).totals.unmetMWh <= SHORTFALL_THRESHOLD_MWH;

  let rec;
  if (risk.level === 'LOW') {
    rec = { text: 'No action needed', batteryMode: 'AUTO', dieselReserved: false };
  } else if (risk.level === 'HIGH' && batteryCovers('CHARGE')) {
    rec = { text: 'Charge battery now, discharge at evening peak', batteryMode: 'CHARGE', dieselReserved: false };
  } else if (batteryCovers('AUTO')) {
    rec = { text: 'Keep battery on AUTO to cover the gaps', batteryMode: 'AUTO', dieselReserved: false };
  } else {
    rec = { text: 'Reserve diesel backup', batteryMode: 'AUTO', dieselReserved: true };
  }

  rec.buildAdvice = null;
  if (recentShortDays >= REPEAT_SHORT_DAYS) {
    const site = bestBuildSite(sites, turbines);
    if (site) rec.buildAdvice = `Build more capacity at ${site.name}`;
  }
  return rec;
}

/** How many of the most recent days ended short (diesel or blackout)? */
export function countRecentShortDays(dayResults) {
  return dayResults.slice(-REPEAT_WINDOW_DAYS)
    .filter((t) => t.dieselMWh + t.unmetMWh > SHORTFALL_THRESHOLD_MWH).length;
}

/**
 * Replay the whole game with the decision rules always followed.
 * forecastKind 'model'       -> uses the AI forecast (P10/P50/P90)
 * forecastKind 'persistence' -> uses the naive forecast (tomorrow = today)
 * The turbines are whatever the player had built on each day.
 * @param dayRecords [{ turbines, reservoirFraction, forecastBySite }]
 */
export function replayWithRules(dayRecords, forecastKind) {
  let batterySoc = BATTERY_START_MWH;
  const results = [];
  const sum = { blackoutVillageHours: 0, co2Kg: 0, dieselMWh: 0, dieselDays: 0 };

  for (const day of dayRecords) {
    let forecastBySite = day.forecastBySite;
    if (forecastKind === 'persistence') {
      forecastBySite = {};
      for (const siteId in day.forecastBySite) {
        const naive = day.forecastBySite[siteId].persistence;
        forecastBySite[siteId] = { p10: naive, p50: naive, p90: naive };
      }
    }
    const common = { forecastBySite, turbines: day.turbines, reservoirFraction: day.reservoirFraction };
    const risk = assessRisk(common);
    const rec = recommend({ ...common, risk, batterySoc, recentShortDays: countRecentShortDays(results) });

    // The day itself always runs on the ACTUAL wind.
    const outcome = simulateDay({
      windBySite: pickWind(day.forecastBySite, 'actual'),
      turbines: day.turbines, reservoirFraction: day.reservoirFraction,
      batterySoc, batteryMode: rec.batteryMode, dieselReserved: rec.dieselReserved,
    });
    batterySoc = outcome.endSoc;
    results.push(outcome.totals);
    sum.blackoutVillageHours += outcome.totals.blackoutVillageHours;
    sum.co2Kg += outcome.totals.co2Kg;
    sum.dieselMWh += outcome.totals.dieselMWh;
    if (rec.dieselReserved) sum.dieselDays++;
  }
  return sum;
}
