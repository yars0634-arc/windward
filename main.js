// WINDWARD main file: loads data, holds the game state and runs the day loop.
// Each day goes BUILD -> FORECAST -> DECIDE -> RUN -> RESULTS -> next day.

import * as sim from './sim.js';
import * as riskRules from './risk.js';
import * as ui from './ui.js';
import { createWorld } from './world.js';

// ---- Tuning constants ----
const SECONDS_PER_HOUR = 0.5; // RUN phase speed: 24 hours take 12 seconds

let sites = [];        // from sites.json
let forecastMeta = {}; // model scores + SAMPLE label from forecasts.json
let forecastsByDate = {}; // { date: { siteId: forecast } }
let dates = [];        // dates that have a forecast for every site
let world = null;
let state = null;
let muted = false;

// ---- Loading ----
async function loadData() {
  const [sitesFile, forecastFile] = await Promise.all([
    fetch('sites.json').then((r) => r.json()),
    fetch('forecasts.json').then((r) => r.json()),
  ]);
  sites = sitesFile.sites;
  const { forecasts, ...meta } = forecastFile;
  forecastMeta = meta;
  for (const forecast of forecasts) {
    forecastsByDate[forecast.date] = forecastsByDate[forecast.date] || {};
    forecastsByDate[forecast.date][forecast.site] = forecast;
  }
  dates = Object.keys(forecastsByDate)
    .filter((date) => sites.every((site) => forecastsByDate[date][site.id]))
    .sort();
  if (dates.length < sim.GAME_DAYS) throw new Error('forecasts.json needs at least 7 days for every site.');
}

// ---- Game state ----
function newGame(tutorial = false) {
  // Pick a random week from the test period, so each game is different.
  const startIndex = Math.floor(Math.random() * (dates.length - sim.GAME_DAYS + 1));
  state = {
    tutorial,                  // true = one guided practice day that doesn't count
    phase: 'BUILD',
    dayIndex: 0,
    weekDates: dates.slice(startIndex, startIndex + sim.GAME_DAYS),
    budget: sim.START_BUDGET,
    turbines: {},              // { siteId: count }
    selectedSiteId: null,
    batterySoc: sim.BATTERY_START_MWH,
    batteryMode: 'AUTO',
    dieselReserved: false,
    risk: null,
    recommendation: null,
    outcome: null,             // result of simulateDay for the current day
    runTime: 0,                // seconds into the RUN animation
    runHour: -1,
    dayTotals: [],             // one totals object per finished day
    dayRecords: [],            // what the end-screen replay needs
    followedCount: 0,
    blackoutHours: 0,
    co2Kg: 0,
  };
  window.windward = state; // handy for debugging in the browser console
}

const today = () => forecastsByDate[state.weekDates[state.dayIndex]];
const reservoir = () => sim.RESERVOIR_BY_DAY[state.dayIndex];
const dayNumber = () => state.dayIndex + 1;

function refreshHud() {
  ui.updateHud({
    day: dayNumber(), totalDays: sim.GAME_DAYS, tutorial: state.tutorial, phase: state.phase, budget: state.budget,
    reservoirFraction: reservoir(), batterySoc: state.batterySoc,
    batteryCapacity: sim.BATTERY_CAPACITY_MWH, blackoutHours: state.blackoutHours,
    co2Kg: state.co2Kg, muted,
  });
}

function refreshSiteLabels() {
  for (const site of sites) {
    const count = state.turbines[site.id] || 0;
    world.setSiteLabel(site.id,
      `<b>${site.name}</b><br>💨 ${site.meanWind.toFixed(1)} m/s · $${sim.turbineCost(site)}k · ${count}/${sim.MAX_TURBINES_PER_SITE}`);
  }
}

/** Average wind across the sites the player has built on (or all sites if none yet). */
function chartData(includeActual) {
  let used = sites.filter((site) => state.turbines[site.id]);
  const title = used.length ? 'Average wind at your turbine sites (m/s)' : 'Average wind across all sites (m/s)';
  if (!used.length) used = sites;
  const average = (key) => Array.from({ length: 24 }, (_, hour) =>
    used.reduce((sum, site) => sum + today()[site.id][key][hour], 0) / used.length);
  const chart = { p10: average('p10'), p50: average('p50'), p90: average('p90') };
  if (includeActual) chart.actual = average('actual');
  return { title, chart };
}

/** Tutorial mode: tell the UI which coaching tip fits what the player is doing. */
function refreshTutorialTip() {
  let step = null;
  if (state.tutorial) {
    step = state.phase.toLowerCase(); // forecast, decide, run, results
    if (state.phase === 'BUILD') {
      if (sim.countTurbines(state.turbines) > 0) step = 'built';
      else step = state.selectedSiteId ? 'build' : 'select';
    }
  }
  ui.setTutorialStep(step);
}

// ---- Phase: BUILD ----
function enterBuild() {
  state.phase = 'BUILD';
  world.setDaytime();
  world.setReservoir(reservoir());
  world.setVillagesOn(sim.VILLAGES.map(() => true));
  world.setWind(Object.fromEntries(sites.map((site) => [site.id, site.meanWind])));
  world.setSitesClickable(true);
  showBuild();
}

function showBuild() {
  world.setTurbines(state.turbines);
  world.setSelectedSite(state.selectedSiteId);
  refreshSiteLabels();
  refreshHud();
  refreshTutorialTip();
  ui.showBuildPanel({
    lockForecast: state.tutorial && sim.countTurbines(state.turbines) === 0,
    day: dayNumber(),
    selectedId: state.selectedSiteId,
    budget: state.budget,
    hydroMW: sim.hydroOutputMW(reservoir()),
    peakDemandMW: Math.max(...Array.from({ length: 24 }, (_, hour) => sim.totalDemandMW(hour))),
    turbineCount: sim.countTurbines(state.turbines),
    buildAdvice: state.recommendation?.buildAdvice,
    sites: sites.map((site) => ({
      ...site,
      count: state.turbines[site.id] || 0,
      max: sim.MAX_TURBINES_PER_SITE,
      cost: sim.turbineCost(site),
      distanceKm: sim.siteDistanceKm(site),
      village: sim.nearestVillage(site).name,
    })),
  });
}

function selectSite(siteId) {
  if (state.phase !== 'BUILD') return;
  state.selectedSiteId = siteId;
  showBuild();
}

function buildTurbine() {
  const site = sites.find((s) => s.id === state.selectedSiteId);
  const count = state.turbines[site.id] || 0;
  const cost = sim.turbineCost(site);
  if (state.phase !== 'BUILD' || count >= sim.MAX_TURBINES_PER_SITE || cost > state.budget) {
    ui.playSound('error');
    return;
  }
  state.turbines[site.id] = count + 1;
  state.budget -= cost;
  ui.playSound('build');
  showBuild();
}

function visitSite() {
  if (!state.selectedSiteId) return;
  world.visitSite(state.selectedSiteId);
  ui.showToast('Visiting site · click the map to return');
}

// ---- Phase: FORECAST ----
function enterForecast() {
  state.phase = 'FORECAST';
  state.selectedSiteId = null;
  world.setSelectedSite(null);
  world.setSitesClickable(false);

  // Only work out the risk the first time (not when coming back from DECIDE).
  if (!state.risk) {
    const situation = { forecastBySite: today(), turbines: state.turbines, reservoirFraction: reservoir() };
    state.risk = riskRules.assessRisk(situation);
    state.recommendation = riskRules.recommend({
      ...situation, risk: state.risk, batterySoc: state.batterySoc, sites,
      recentShortDays: riskRules.countRecentShortDays(state.dayTotals),
    });
    state.batteryMode = 'AUTO';
    state.dieselReserved = false;
  }
  refreshHud();
  refreshTutorialTip();
  const { title, chart } = chartData(false);
  ui.showForecastPanel({
    day: dayNumber(), risk: state.risk, recommendation: state.recommendation, chartTitle: title, chart,
  });
}

// ---- Phase: DECIDE ----
function isFollowing() {
  return state.batteryMode === state.recommendation.batteryMode
    && state.dieselReserved === state.recommendation.dieselReserved;
}

function enterDecide() {
  state.phase = 'DECIDE';
  refreshHud();
  refreshTutorialTip();
  ui.showDecidePanel({
    day: dayNumber(), risk: state.risk, recommendation: state.recommendation,
    batteryMode: state.batteryMode, dieselReserved: state.dieselReserved,
    dieselCost: sim.DIESEL_RESERVE_COST, canAffordDiesel: state.budget >= sim.DIESEL_RESERVE_COST,
    following: isFollowing(), batteryModes: sim.BATTERY_MODES,
  });
}

function acceptRecommendation() {
  state.batteryMode = state.recommendation.batteryMode;
  // Diesel can only be reserved if the player can pay for it.
  state.dieselReserved = state.recommendation.dieselReserved && state.budget >= sim.DIESEL_RESERVE_COST;
  enterDecide();
}

// ---- Phase: RUN ----
function enterRun() {
  state.phase = 'RUN';
  if (state.dieselReserved) state.budget -= sim.DIESEL_RESERVE_COST;
  state.followed = isFollowing();
  if (state.followed) state.followedCount++;

  // The day always runs on the ACTUAL wind, not the forecast.
  state.outcome = sim.simulateDay({
    windBySite: riskRules.pickWind(today(), 'actual'),
    turbines: state.turbines, reservoirFraction: reservoir(),
    batterySoc: state.batterySoc, batteryMode: state.batteryMode, dieselReserved: state.dieselReserved,
  });
  state.dayRecords.push({
    turbines: { ...state.turbines }, reservoirFraction: reservoir(), forecastBySite: today(),
  });
  state.runTime = 0;
  state.runHour = -1;
  refreshHud();
  refreshTutorialTip();
  ui.showRunPanel({ day: dayNumber() });
}

/** Called every frame during RUN: move the clock and update the world. */
function updateRun(dt) {
  state.runTime += dt;
  const hourFloat = state.runTime / SECONDS_PER_HOUR;
  if (hourFloat >= 24) { enterResults(); return; }
  world.setHour(hourFloat);

  const hour = Math.floor(hourFloat);
  if (hour === state.runHour) return;
  const wasDark = state.runHour >= 0 && state.outcome.hours[state.runHour].unmet > 0;
  state.runHour = hour;
  const hourData = state.outcome.hours[hour];
  world.setVillagesOn(hourData.villagesOn);
  world.setWind(Object.fromEntries(sites.map((site) => [site.id, today()[site.id].actual[hour]])));
  ui.updateRunPanel(hourData, sim.VILLAGES.map((v) => v.name));
  if (hourData.unmet > 0 && !wasDark) ui.playSound('blackout');
}

// ---- Phase: RESULTS ----
function enterResults() {
  state.phase = 'RESULTS';
  const totals = state.outcome.totals;
  state.batterySoc = state.outcome.endSoc;
  state.blackoutHours += totals.blackoutVillageHours;
  state.co2Kg += totals.co2Kg;
  state.dayTotals.push(totals);

  world.setDaytime();
  world.setVillagesOn(sim.VILLAGES.map(() => true));
  if (totals.blackoutVillageHours === 0) ui.playSound('success');
  refreshHud();
  refreshTutorialTip();
  const { title, chart } = chartData(true);
  ui.showResultsPanel({
    day: dayNumber(), isLastDay: state.dayIndex === sim.GAME_DAYS - 1, tutorial: state.tutorial, totals,
    followed: state.followed, chartTitle: `${title}: forecast vs actual`, chart, income: sim.DAILY_INCOME,
  });
}

function nextDay() {
  if (state.tutorial) { startGame(); return; } // practice day over: begin the real week
  if (state.dayIndex === sim.GAME_DAYS - 1) { enterEnd(); return; }
  state.dayIndex++;
  state.budget += sim.DAILY_INCOME;
  state.risk = null;
  enterBuild();
}

// ---- End screen ----
function enterEnd() {
  state.phase = 'END';
  const sumPlayer = { blackoutVillageHours: state.blackoutHours, co2Kg: state.co2Kg };
  ui.showEndScreen({
    co2Kg: state.co2Kg,
    baselineCo2Kg: sim.allDieselCo2Kg() * sim.GAME_DAYS,
    blackoutHours: state.blackoutHours,
    followed: state.followedCount,
    totalRecs: sim.GAME_DAYS,
    player: sumPlayer,
    // Re-run the same week with the rules always followed, once per forecast type.
    ai: riskRules.replayWithRules(state.dayRecords, 'model'),
    naive: riskRules.replayWithRules(state.dayRecords, 'persistence'),
    model: forecastMeta, isSample: forecastMeta.sample, dataLabel: forecastMeta.label,
  });
}

function startGame(tutorial = false) {
  newGame(tutorial === true);
  ui.hideOverlay();
  enterBuild();
}

// ---- Start-up ----
async function main() {
  ui.initUI({
    startGame: () => startGame(), playAgain: () => startGame(), startTutorial: () => startGame(true), selectSite, buildTurbine, visitSite,
    toForecast: enterForecast, toDecide: enterDecide, acceptRecommendation,
    setBatteryMode: (mode) => { state.batteryMode = mode; enterDecide(); },
    toggleDiesel: () => { state.dieselReserved = !state.dieselReserved; enterDecide(); },
    runDay: enterRun, skipRun: () => { if (state.phase === 'RUN') enterResults(); },
    nextDay,
    toggleSound: () => { muted = !muted; ui.setMuted(muted); refreshHud(); },
  });

  try {
    await loadData();
  } catch (error) {
    ui.showError(`Could not load the game data (${error.message}). Open the game through a local
      web server, not by double-clicking index.html. See the README.`);
    return;
  }

  world = createWorld(document.getElementById('scene'), document.getElementById('labels'), sites, {
    onSiteClick: selectSite,
    onVisitEnd: () => ui.showToast(''),
  });
  newGame(); // so the map behind the start screen looks alive
  world.setReservoir(reservoir());
  world.setDaytime();
  refreshSiteLabels();
  refreshHud();
  ui.showStartScreen({ dataLabel: forecastMeta.label, isSample: forecastMeta.sample });

  let lastTime = performance.now();
  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.1); // cap so a paused tab doesn't jump
    lastTime = now;
    if (state.phase === 'RUN') updateRun(dt);
    world.update(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
