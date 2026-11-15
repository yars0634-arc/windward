# WINDWARD

A browser strategy game set around Lake Turkana, northern Kenya. Drought is
weakening the hydro dam, so you build wind turbines and manage a battery to
keep three villages powered. An ML model forecasts the wind; the game turns
that forecast into a blackout-risk rating and a recommended action.

> "Our AI doesn't forecast the weather, it forecasts when communities are at
> risk of losing power."

All files sit in one folder (no subfolders).

## 1. Get real data and train the model (run once, on your laptop)

    pip install -r requirements.txt
    python fetch_wind.py      # downloads ~3 years of hourly wind per site into raw/
    python train_model.py     # trains, prints the pitch summary, writes JSON

`train_model.py` overwrites `forecasts.json` and `sites.json`. Until you run
it, the game uses SAMPLE files made from synthetic wind
(`python make_sample.py` recreates them).

## 2. Run the game locally

    python -m http.server 8000

Then open http://localhost:8000 . (Double-clicking index.html will not work:
browsers block ES modules and JSON loading from file://.)

## 3. Deploy to Netlify

Import this repo on Netlify ("Add new site > Import an existing project") and
leave the build command empty, or drag this folder onto
https://app.netlify.com/drop .

## Files

    index.html            page + styles
    main.js               setup, game loop, state machine, tutorial mode
    world.js              3D scene (Three.js)
    sim.js                power simulation (pure functions)
    risk.js               blackout risk + recommendations (pure functions)
    ui.js                 HUD, chart, panels, start/end screens, sound
    three.module.min.js   Three.js r170 (MIT licence, see THREE_LICENSE.txt)
    forecasts.json        model forecasts used by the game
    sites.json            wind sites used by the game
    sites_config.py       site coordinates shared by the Python scripts
    fetch_wind.py         downloads wind data from Open-Meteo
    train_model.py        trains the model, exports JSON
    make_sample.py        makes the SAMPLE JSON from synthetic wind

All balance numbers are constants at the top of `sim.js` and `risk.js`.

Credits: Wind data: Open-Meteo · Forecast model: built by our team
