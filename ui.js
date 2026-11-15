// WINDWARD user interface: HUD, side panel, forecast chart, start + end screens, sound.
// This file only draws things. Game rules live in sim.js and risk.js.

const $ = (id) => document.getElementById(id);
const PHASES = ['BUILD', 'FORECAST', 'DECIDE', 'RUN', 'RESULTS'];

// ---- Text shown to the player ----
const STORY = `Lake Turkana, northern Kenya. Year after year of drought has left the
reservoir behind the hydro dam running low, and three villages depend on it for power.
This windy corridor is home to one of Africa's largest wind farms. You have one week to build turbines,
manage a battery and keep the lights on, guided by an AI that forecasts blackout risk.`;

const HOW_TO_PLAY = [
  ['BUILD', 'Click a site on the map and build turbines. Windy sites far from a village cost more.'],
  ['FORECAST', 'The AI predicts tomorrow\'s wind and rates the blackout risk.'],
  ['DECIDE', 'Set the battery, choose whether to pay for diesel backup, and accept or override the AI.'],
  ['RUN', 'Watch the day play out with the real wind. No power and no diesel means blackouts.'],
  ['RESULTS', 'See how it went. The drought gets worse every day for 7 days.'],
];

// One-line facts shown after each day (general, well-established facts only).
const CLIMATE_FACTS = [
  'Wind power grows with the cube of wind speed: double the wind gives about eight times the power.',
  'Drought cuts hydropower because less water is available to flow through the dam\'s turbines.',
  'A wind turbine produces no CO₂ while it is generating electricity.',
  'Batteries do not make energy. They move it from when it is plentiful to when it is needed.',
  'Burning one litre of diesel releases roughly 2.7 kg of CO₂.',
  'The real Lake Turkana Wind Power project has 365 turbines and about 310 MW of capacity.',
  'Good forecasts let grid operators line up backup power before a shortage, not after it.',
];

// Tutorial mode: one practice day with a coaching tip on every screen.
const TUTORIAL_STEPS = {
  select: 'Pick a site. Click one of the hexagon tiles on the map, or a row in the list below.',
  build: 'Compare the sites: windier ones make more power, but sites far from a village cost more. Press the yellow Build button.',
  built: 'A power line now links your turbine to the nearest village. Build more if you can afford it, then press "See tomorrow\'s forecast".',
  forecast: 'The line is the AI\'s best guess of tomorrow\'s wind. The shaded band is how wrong it could be. The badge tells you if the villages could run short of power.',
  decide: 'Choose how the battery behaves and whether to pay for diesel backup. "Accept recommendation" sets both the way the AI suggests. Then run the day.',
  run: 'The day now plays out with the REAL wind. Green squares mean every village had power, orange means diesel was burned, red means a blackout.',
  results: 'Yellow is the wind that really blew, next to the forecast. In the real game you play 7 days and the reservoir drops each day, so plan ahead.',
};
const TUTORIAL_ORDER = Object.keys(TUTORIAL_STEPS);
let tutorialStep = null;

/** Show a coaching tip above the panel. Pass null to turn tips off. */
export function setTutorialStep(step) { tutorialStep = step; }

const BATTERY_MODE_HELP = {
  AUTO: 'Charge on surplus, discharge whenever short.',
  CHARGE: 'Store surplus and hold it for the evening peak.',
  DISCHARGE: 'Release when short, never charge.',
};

// ---- Small helpers ----
const money = (k) => `$${Math.round(k)}k`;
const fixed = (value, digits = 1) => Number(value).toFixed(digits);
const tonnes = (kg) => `${fixed(kg / 1000)} t`;
const riskBadge = (level) => `<span class="badge risk-${level}">${level} RISK</span>`;

function stat(label, value) {
  return `<div class="stat"><span>${label}</span><b>${value}</b></div>`;
}

/** Hook up every button: <button data-action="name" data-value="x"> calls handlers.name('x'). */
export function initUI(handlers) {
  document.body.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    playSound('click');
    handlers[button.dataset.action]?.(button.dataset.value);
  });
}

// ---- HUD (top bar) ----
export function updateHud({ day, totalDays, tutorial, phase, budget, reservoirFraction, batterySoc, batteryCapacity,
  blackoutHours, co2Kg, muted }) {
  const steps = PHASES.map((p) => `<span class="${p === phase ? 'current' : ''}">${p}</span>`).join('›');
  $('hud').innerHTML = `
    <div class="hud-title">WINDWARD</div>
    <div class="hud-item"><span>Day</span><b>${tutorial ? 'Tutorial' : `${day} / ${totalDays}`}</b></div>
    <div class="hud-steps">${steps}</div>
    <div class="hud-item"><span>Budget</span><b>${money(budget)}</b></div>
    <div class="hud-item"><span>Reservoir</span><b>${Math.round(reservoirFraction * 100)}%</b></div>
    <div class="hud-item"><span>Battery</span><b>${fixed(batterySoc)} / ${batteryCapacity} MWh</b></div>
    <div class="hud-item"><span>Blackout hrs</span><b>${blackoutHours}</b></div>
    <div class="hud-item"><span>CO₂</span><b>${tonnes(co2Kg)}</b></div>
    <button class="ghost" data-action="toggleSound" title="Sound on/off">${muted ? '🔇' : '🔊'}</button>`;
}

function setPanel(html) {
  let tip = '';
  if (tutorialStep) {
    const number = TUTORIAL_ORDER.indexOf(tutorialStep) + 1;
    tip = `<div class="tip"><b>Tutorial · step ${number} of ${TUTORIAL_ORDER.length}</b>${TUTORIAL_STEPS[tutorialStep]}</div>`;
  }
  $('panel').innerHTML = tip + html;
  $('panel').scrollTop = 0;
}

// ---- BUILD ----
export function showBuildPanel({ day, sites, selectedId, budget, hydroMW, peakDemandMW, turbineCount, buildAdvice, lockForecast }) {
  const rows = sites.map((s) => `
    <button class="site-row ${s.id === selectedId ? 'selected' : ''}" data-action="selectSite" data-value="${s.id}">
      <b>${s.name}</b><span>${s.count}/${s.max} built</span>
      <small>💨 ${fixed(s.meanWind)} m/s avg · ±${fixed(s.windVariability)} gusts · ${fixed(s.distanceKm, 0)} km to ${s.village}</small>
      <em>${money(s.cost)}</em>
    </button>`).join('');
  const selected = sites.find((s) => s.id === selectedId);
  let action = '<p class="hint">Click a site on the map (or in the list) to select it.</p>';
  if (selected) {
    const full = selected.count >= selected.max;
    const tooDear = selected.cost > budget;
    const label = full ? 'Site is full' : tooDear ? `Not enough budget (${money(selected.cost)})` : `Build turbine at ${selected.name} (${money(selected.cost)})`;
    action = `
      <button class="primary" data-action="buildTurbine" ${full || tooDear ? 'disabled' : ''}>${label}</button>
      <button data-action="visitSite">🎥 Visit ${selected.name}</button>`;
  }
  setPanel(`
    <h2>Day ${day}: Build</h2>
    <p>Today the dam gives <b>${fixed(hydroMW)} MW</b>. Evening demand peaks at <b>${fixed(peakDemandMW)} MW</b>.
       You have <b>${turbineCount}</b> turbine${turbineCount === 1 ? '' : 's'} (2 MW each at full wind).</p>
    ${buildAdvice ? `<p class="advice">🤖 ${buildAdvice}</p>` : ''}
    <div class="site-list">${rows}</div>
    ${action}
    <button class="primary next" data-action="toForecast" ${lockForecast ? 'disabled' : ''}>See tomorrow's forecast ▶</button>`);
}

// ---- FORECAST ----
export function showForecastPanel({ day, risk, recommendation, chartTitle, chart }) {
  setPanel(`
    <h2>Day ${day}: Forecast</h2>
    <p class="chart-title">${chartTitle}</p>
    <canvas id="chart" class="chart"></canvas>
    <p class="legend"><i class="swatch band"></i>P10–P90 range <i class="swatch p50"></i>P50 forecast</p>
    <div class="risk-box">
      ${riskBadge(risk.level)}
      <p>Expected shortfall: <b>${fixed(risk.expectedShortfallMWh)} MWh</b>
         (${fixed(risk.expectedShortfallPct)}% of demand) before battery or diesel.</p>
      <small>Short in low wind (P10): ${fixed(risk.shortfallMWh.p10)} MWh ·
             high wind (P90): ${fixed(risk.shortfallMWh.p90)} MWh</small>
    </div>
    <div class="advice">🤖 <b>${recommendation.text}</b>
      ${recommendation.buildAdvice ? `<br><small>Also: ${recommendation.buildAdvice} tomorrow.</small>` : ''}</div>
    <button class="primary next" data-action="toDecide">Make decisions ▶</button>`);
  drawChart($('chart'), chart);
}

// ---- DECIDE ----
export function showDecidePanel({ day, risk, recommendation, batteryMode, dieselReserved, dieselCost,
  canAffordDiesel, following, batteryModes }) {
  const modes = batteryModes.map((mode) => `
    <button class="choice ${mode === batteryMode ? 'selected' : ''}" data-action="setBatteryMode" data-value="${mode}">
      <b>${mode}</b><small>${BATTERY_MODE_HELP[mode]}</small></button>`).join('');
  setPanel(`
    <h2>Day ${day}: Decide</h2>
    <div class="advice">${riskBadge(risk.level)}<br>🤖 <b>${recommendation.text}</b></div>
    <button data-action="acceptRecommendation" ${following ? 'disabled' : ''}>✓ Accept recommendation</button>
    <h3>Battery mode</h3>
    <div class="choices">${modes}</div>
    <h3>Diesel backup</h3>
    <button class="choice ${dieselReserved ? 'selected' : ''}" data-action="toggleDiesel" ${canAffordDiesel || dieselReserved ? '' : 'disabled'}>
      <b>${dieselReserved ? '☑' : '☐'} Reserve diesel (${money(dieselCost)})</b>
      <small>Covers any shortfall, but burns fuel and emits CO₂. Without it, a shortfall is a blackout.</small></button>
    <p class="follow ${following ? 'yes' : 'no'}">${following ? '✓ Following the AI recommendation' : '✗ Overriding the AI recommendation'}</p>
    <button data-action="toForecast">◀ Back to forecast</button>
    <button class="primary next" data-action="runDay">Run the day ▶</button>`);
}

// ---- RUN ----
export function showRunPanel({ day }) {
  const cells = Array.from({ length: 24 }, (_, h) => `<i id="cell-${h}"></i>`).join('');
  setPanel(`
    <h2>Day ${day}: Running</h2>
    <div class="clock" id="clock">00:00</div>
    <div class="timeline">${cells}</div>
    <p class="legend"><i class="swatch ok"></i>Powered <i class="swatch diesel"></i>Diesel <i class="swatch out"></i>Blackout</p>
    <h3>Supply vs demand</h3>
    <div class="meter"><div id="meter-bars"></div><div id="meter-demand"></div></div>
    <p class="legend"><i class="swatch wind"></i>Wind <i class="swatch hydro"></i>Hydro
      <i class="swatch battery"></i>Battery <i class="swatch diesel"></i>Diesel <i class="swatch demand"></i>Demand</p>
    <div id="run-stats"></div>
    <button data-action="skipRun">Skip ⏭</button>`);
}

/** Update the RUN panel for one simulated hour. */
export function updateRunPanel(hourData, villageNames) {
  const { hour, wind, hydro, demand, battery, diesel, unmet, villagesOn, soc } = hourData;
  $('clock').textContent = `${String(hour).padStart(2, '0')}:00`;
  $(`cell-${hour}`).className = unmet > 0 ? 'out' : diesel > 0 ? 'diesel' : 'ok';

  const discharge = Math.max(battery, 0);
  const scale = Math.max(wind + hydro + discharge + diesel, demand) * 1.1;
  const bar = (kind, mw) => `<div class="bar ${kind}" style="width:${(100 * mw) / scale}%"></div>`;
  $('meter-bars').innerHTML = bar('wind', wind) + bar('hydro', hydro) + bar('battery', discharge) + bar('diesel', diesel);
  $('meter-demand').style.left = `${(100 * demand) / scale}%`;

  const dark = villageNames.filter((_, i) => !villagesOn[i]);
  $('run-stats').innerHTML =
    stat('Wind', `${fixed(wind)} MW`) + stat('Hydro', `${fixed(hydro)} MW`) +
    stat('Battery', `${battery > 0 ? 'giving' : battery < 0 ? 'charging' : 'idle'} · ${fixed(soc)} MWh`) +
    stat('Demand', `${fixed(demand)} MW`) +
    (diesel > 0 ? stat('Diesel', `${fixed(diesel)} MW`) : '') +
    (dark.length ? `<p class="alert">⚠ Blackout: ${dark.join(', ')}</p>` : '');
}

// ---- RESULTS ----
export function showResultsPanel({ day, isLastDay, tutorial, totals, followed, chartTitle, chart, income }) {
  const fact = CLIMATE_FACTS[(day - 1) % CLIMATE_FACTS.length];
  setPanel(`
    <h2>Day ${day}: Results</h2>
    ${stat('Blackout hours (village-hours)', totals.blackoutVillageHours)}
    ${stat('Diesel used', `${fixed(totals.dieselMWh)} MWh`)}
    ${stat('CO₂ emitted', tonnes(totals.co2Kg))}
    ${stat('Wind energy', `${fixed(totals.windMWh)} MWh`)}
    ${stat('AI recommendation', followed ? 'followed ✓' : 'overridden ✗')}
    <p class="chart-title">${chartTitle}</p>
    <canvas id="chart" class="chart"></canvas>
    <p class="legend"><i class="swatch band"></i>P10–P90 <i class="swatch p50"></i>Forecast <i class="swatch actual"></i>Actual</p>
    <p class="fact">🌍 ${fact}</p>
    ${isLastDay || tutorial ? '' : `<p class="hint">Tomorrow: +${money(income)} budget, and the reservoir drops again.</p>`}
    <button class="primary next" data-action="nextDay">${tutorial ? 'Start the real game ▶' : isLastDay ? 'See final report ▶' : 'Next day ▶'}</button>`);
  drawChart($('chart'), chart);
}

// ---- Forecast chart (plain canvas) ----
/** chart = { p10, p50, p90, actual? } where each is an array of 24 wind speeds. */
export function drawChart(canvas, { p10, p50, p90, actual }) {
  const scale = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 300;
  const height = canvas.clientHeight || 150;
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  const pad = { left: 30, right: 8, top: 8, bottom: 20 };
  const maxWind = Math.ceil(Math.max(...p90, ...p50, ...(actual || [0]), 5) / 5) * 5;
  const x = (hour) => pad.left + (hour / 23) * (width - pad.left - pad.right);
  const y = (wind) => height - pad.bottom - (wind / maxWind) * (height - pad.top - pad.bottom);

  // Grid + axis labels
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = '#9fb4b8';
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  for (let wind = 0; wind <= maxWind; wind += 5) {
    ctx.beginPath(); ctx.moveTo(pad.left, y(wind)); ctx.lineTo(width - pad.right, y(wind)); ctx.stroke();
    ctx.fillText(wind, 8, y(wind) + 3);
  }
  for (const hour of [0, 6, 12, 18, 23]) ctx.fillText(`${hour}h`, x(hour) - 7, height - 5);

  // P10–P90 band
  ctx.beginPath();
  p90.forEach((wind, hour) => ctx.lineTo(x(hour), y(wind)));
  for (let hour = 23; hour >= 0; hour--) ctx.lineTo(x(hour), y(p10[hour]));
  ctx.closePath();
  ctx.fillStyle = 'rgba(88, 196, 220, 0.28)';
  ctx.fill();

  const line = (values, color, lineWidth) => {
    ctx.beginPath();
    values.forEach((wind, hour) => ctx.lineTo(x(hour), y(wind)));
    ctx.strokeStyle = color; ctx.lineWidth = lineWidth; ctx.stroke();
  };
  line(p50, '#58c4dc', 2);
  if (actual) line(actual, '#ffc94d', 2);
}

// ---- Start + end screens ----
export function showStartScreen({ dataLabel, isSample }) {
  const steps = HOW_TO_PLAY.map(([name, text]) => `<li><b>${name}</b> ${text}</li>`).join('');
  $('overlay').innerHTML = `
    <div class="card">
      <h1>WINDWARD</h1>
      <p class="tagline">Our AI doesn't forecast the weather. It forecasts when communities are at risk of losing power.</p>
      <p>${STORY}</p>
      <div class="how"><h3>How to play</h3><ol>${steps}</ol></div>
      ${isSample ? `<p class="sample">⚠ ${dataLabel}. Run the Python scripts to use real wind data.</p>` : `<p class="hint">${dataLabel}</p>`}
      <button class="primary" data-action="startGame">Start ▶</button>
      <button data-action="startTutorial">🎓 Tutorial: a guided practice day</button>
    </div>`;
  $('overlay').hidden = false;
}

export function showEndScreen({ co2Kg, baselineCo2Kg, blackoutHours, followed, totalRecs, player, ai, naive,
  model, isSample, dataLabel }) {
  const avoided = baselineCo2Kg > 0 ? 100 * (1 - co2Kg / baselineCo2Kg) : 0;
  const row = (name, r) => `<tr><td>${name}</td><td>${r.blackoutVillageHours}</td><td>${tonnes(r.co2Kg)}</td></tr>`;
  $('overlay').innerHTML = `
    <div class="card">
      <h1>Week complete</h1>
      <div class="end-grid">
        ${stat('Total blackout hours', blackoutHours)}
        ${stat('CO₂ emitted', tonnes(co2Kg))}
        ${stat('All-diesel baseline', tonnes(baselineCo2Kg))}
        ${stat('CO₂ avoided vs all-diesel', `${fixed(avoided, 0)}%`)}
        ${stat('Recommendations followed', `${followed} / ${totalRecs}`)}
      </div>
      <h3>AI vs naive forecast</h3>
      <p class="headline">With AI: <b>${ai.blackoutVillageHours}</b> blackout hours /
         With naive forecast: <b>${naive.blackoutVillageHours}</b></p>
      <p class="hint">Same week, same turbines you built, same decision rules followed every day.
         Only the forecast changes. Naive = "tomorrow's wind will be the same as today's".</p>
      <table>
        <tr><th></th><th>Blackout hours</th><th>CO₂</th></tr>
        ${row('Your game', player)}${row('AI forecast, rules always followed', ai)}${row('Naive forecast, rules always followed', naive)}
      </table>
      <p class="hint">Forecast error over the test period: model ${fixed(model.modelMAE, 2)} m/s vs
         naive ${fixed(model.persistenceMAE, 2)} m/s (${fixed(model.improvementPct, 0)}% better).</p>
      ${isSample ? `<p class="sample">⚠ ${dataLabel}</p>` : ''}
      <p class="credits">Wind data: Open-Meteo · Forecast model: built by our team</p>
      <button class="primary" data-action="playAgain">Play again ↻</button>
    </div>`;
  $('overlay').hidden = false;
}

export function showError(message) {
  $('overlay').innerHTML = `<div class="card"><h1>WINDWARD</h1><p class="alert">${message}</p></div>`;
  $('overlay').hidden = false;
}

export function hideOverlay() { $('overlay').hidden = true; }

/** Short message at the top of the map. Empty text hides it. */
export function showToast(text) {
  $('toast').textContent = text;
  $('toast').hidden = !text;
}

// ---- Sound (simple beeps made with the Web Audio API, no files needed) ----
const SOUNDS = {
  click: [[520, 0.05]],
  build: [[440, 0.08], [660, 0.12]],
  success: [[523, 0.1], [659, 0.1], [784, 0.2]],
  blackout: [[140, 0.25], [100, 0.35]],
  error: [[200, 0.15]],
};
let audio = null;
let muted = false;

export function setMuted(value) { muted = value; }

export function playSound(name) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    let start = audio.currentTime;
    for (const [frequency, seconds] of SOUNDS[name]) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = name === 'blackout' ? 'sawtooth' : 'triangle';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.08, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + seconds);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(start);
      oscillator.stop(start + seconds);
      start += seconds;
    }
  } catch (error) {
    // Sound is optional: ignore browsers that block or lack Web Audio.
  }
}
