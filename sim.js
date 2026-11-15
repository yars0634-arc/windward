// WINDWARD power simulation. Pure functions only: no Three.js, no DOM.
// All power values are MW, all energy values are MWh, one step = one hour.

// ---- Tuning constants (game balance placeholders, not real-world data) ----

// Turbine power curve
export const CUT_IN_MS = 3.5;      // no power below this wind speed
export const RATED_MS = 12;        // full power from this wind speed
export const CUT_OUT_MS = 25;      // turbine shuts down above this (safety)
export const RATED_MW = 2;         // full power of one turbine
export const MAX_TURBINES_PER_SITE = 3;

// Hydro dam: output = BASE_HYDRO_MW x reservoir fraction
export const BASE_HYDRO_MW = 6;
// Reservoir fraction for each game day. The drought gets worse over time.
export const RESERVOIR_BY_DAY = [0.85, 0.75, 0.65, 0.55, 0.45, 0.38, 0.3];
export const GAME_DAYS = RESERVOIR_BY_DAY.length;

// Demand: each village uses peakMW x DEMAND_SHAPE[hour].
// Low at night, morning bump, evening peak.
export const DEMAND_SHAPE = [
  0.35, 0.32, 0.3, 0.3, 0.35, 0.5, 0.7, 0.75, 0.65, 0.55, 0.5, 0.5,
  0.52, 0.5, 0.5, 0.55, 0.65, 0.8, 0.95, 1.0, 1.0, 0.85, 0.6, 0.42,
];

// Villages are fictional. Order = priority: when power is short, villages
// at the END of the list lose power first.
export const VILLAGES = [
  { id: 'lakeside', name: 'Lakeside', lat: 2.78, lon: 36.7, peakMW: 3.5 },
  { id: 'hilltop', name: 'Hilltop', lat: 2.62, lon: 36.78, peakMW: 2.5 },
  { id: 'eastwell', name: 'Eastwell', lat: 2.85, lon: 36.9, peakMW: 2.0 },
];

// Battery
export const BATTERY_CAPACITY_MWH = 8;
export const BATTERY_MAX_POWER_MW = 2;     // max charge or discharge per hour
export const BATTERY_EFFICIENCY = 0.85;    // round trip, applied when charging
export const BATTERY_START_MWH = 4;
export const EVENING_START_HOUR = 17;      // CHARGE mode holds energy until now
export const BATTERY_MODES = ['AUTO', 'CHARGE', 'DISCHARGE'];

// Diesel backup
// Approximate estimate of CO2 from small diesel generators (kg per kWh).
export const DIESEL_KG_CO2_PER_KWH = 0.8;
export const DIESEL_RESERVE_COST = 70;     // $k per day to keep diesel on standby

// Money ($k)
export const START_BUDGET = 340;
export const DAILY_INCOME = 120;
export const TURBINE_BASE_COST = 100;
export const TRANSMISSION_COST_PER_KM = 4; // longer power line = dearer turbine

const EPSILON = 0.001; // ignore rounding-sized shortfalls

// ---- Turbines ----

/** Power from one turbine (MW) at a wind speed (m/s). */
export function turbinePowerMW(windMs) {
  if (windMs < CUT_IN_MS || windMs > CUT_OUT_MS) return 0;
  if (windMs >= RATED_MS) return RATED_MW;
  const cube = (v) => v * v * v;
  return (RATED_MW * (cube(windMs) - cube(CUT_IN_MS))) / (cube(RATED_MS) - cube(CUT_IN_MS));
}

/** Total wind power (MW) for one hour. turbines = { siteId: count }. */
export function windPowerMW(turbines, windBySite, hour) {
  let total = 0;
  for (const siteId in turbines) {
    const wind = windBySite[siteId];
    if (wind) total += turbines[siteId] * turbinePowerMW(wind[hour]);
  }
  return total;
}

export function countTurbines(turbines) {
  return Object.values(turbines).reduce((sum, n) => sum + n, 0);
}

// ---- Demand and hydro ----

export function villageDemandMW(village, hour) {
  return village.peakMW * DEMAND_SHAPE[hour];
}

export function totalDemandMW(hour) {
  return VILLAGES.reduce((sum, v) => sum + villageDemandMW(v, hour), 0);
}

export function dailyDemandMWh() {
  let total = 0;
  for (let h = 0; h < 24; h++) total += totalDemandMW(h);
  return total;
}

export function hydroOutputMW(reservoirFraction) {
  return BASE_HYDRO_MW * reservoirFraction;
}

// ---- Geography and cost ----

/** Rough distance in km between two lat/lon points (fine for short distances). */
export function distanceKm(a, b) {
  const kmPerDegLat = 110.6;
  const kmPerDegLon = 111.3 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((a.lat - b.lat) * kmPerDegLat, (a.lon - b.lon) * kmPerDegLon);
}

export function nearestVillage(site) {
  let best = VILLAGES[0];
  for (const v of VILLAGES) if (distanceKm(site, v) < distanceKm(site, best)) best = v;
  return best;
}

export function siteDistanceKm(site) {
  return distanceKm(site, nearestVillage(site));
}

/** Cost ($k) of one turbine at a site: base price + power line to nearest village. */
export function turbineCost(site) {
  return Math.round(TURBINE_BASE_COST + TRANSMISSION_COST_PER_KM * siteDistanceKm(site));
}

// ---- One day of simulation ----

/**
 * Simulate 24 hours.
 * @param windBySite        { siteId: [24 wind speeds] }
 * @param turbines          { siteId: count }
 * @param reservoirFraction 0..1
 * @param batterySoc        MWh stored at midnight
 * @param batteryMode       'AUTO' | 'CHARGE' | 'DISCHARGE'
 * @param dieselReserved    true = diesel covers any shortfall (emits CO2)
 * @param useBattery        false = ignore the battery (used for raw risk)
 * @returns { hours: [...], totals: {...}, endSoc }
 */
export function simulateDay({
  windBySite, turbines, reservoirFraction,
  batterySoc = 0, batteryMode = 'AUTO', dieselReserved = false, useBattery = true,
}) {
  let soc = batterySoc;
  const hydro = hydroOutputMW(reservoirFraction);
  const hours = [];
  const totals = {
    demandMWh: 0, windMWh: 0, hydroMWh: 0, rawShortfallMWh: 0,
    dieselMWh: 0, unmetMWh: 0, blackoutVillageHours: 0, co2Kg: 0,
  };

  for (let hour = 0; hour < 24; hour++) {
    const wind = windPowerMW(turbines, windBySite, hour);
    const demand = totalDemandMW(hour);
    const net = wind + hydro - demand; // + surplus, - shortage

    // Battery: positive = discharging into the grid, negative = charging.
    let battery = 0;
    if (useBattery && net > 0 && batteryMode !== 'DISCHARGE') {
      const room = (BATTERY_CAPACITY_MWH - soc) / BATTERY_EFFICIENCY;
      const charge = Math.min(net, BATTERY_MAX_POWER_MW, room);
      soc += charge * BATTERY_EFFICIENCY;
      battery = -charge;
    } else if (useBattery && net < 0) {
      const holding = batteryMode === 'CHARGE' && hour < EVENING_START_HOUR;
      if (!holding) {
        battery = Math.min(-net, BATTERY_MAX_POWER_MW, soc);
        soc -= battery;
      }
    }

    const available = wind + hydro + Math.max(battery, 0);
    let shortfall = Math.max(0, demand - available);
    if (shortfall < EPSILON) shortfall = 0;

    // Cover the shortfall with diesel, or switch villages off.
    let diesel = 0;
    let unmet = 0;
    const villagesOn = VILLAGES.map(() => true);
    if (shortfall > 0 && dieselReserved) {
      diesel = shortfall;
    } else if (shortfall > 0) {
      unmet = shortfall;
      let served = demand;
      for (let i = VILLAGES.length - 1; i >= 0 && served > available + EPSILON; i--) {
        villagesOn[i] = false;
        served -= villageDemandMW(VILLAGES[i], hour);
        totals.blackoutVillageHours++;
      }
    }

    totals.demandMWh += demand;
    totals.windMWh += wind;
    totals.hydroMWh += hydro;
    totals.rawShortfallMWh += Math.max(0, -net);
    totals.dieselMWh += diesel;
    totals.unmetMWh += unmet;
    hours.push({ hour, wind, hydro, demand, battery, diesel, unmet, villagesOn, soc });
  }

  totals.co2Kg = totals.dieselMWh * 1000 * DIESEL_KG_CO2_PER_KWH;
  return { hours, totals, endSoc: soc };
}

/** CO2 (kg) if the whole day's demand were met by diesel. */
export function allDieselCo2Kg() {
  return dailyDemandMWh() * 1000 * DIESEL_KG_CO2_PER_KWH;
}
