// WINDWARD 3D world: terrain, lake, dam, villages, wind sites and turbines.
// Everything is built from simple low-poly primitives (no model files needed).
// To use GLB models later, load them with GLTFLoader and swap them in for the
// primitive groups made in makeVillage() / makeTree().

import * as THREE from '../lib/three.module.min.js';
import {
  VILLAGES, nearestVillage, MAX_TURBINES_PER_SITE, CUT_IN_MS, CUT_OUT_MS, RATED_MS,
} from './sim.js';

// ---- Tuning constants ----
const MAP_CENTER = { lat: 2.75, lon: 36.78 }; // lat/lon shown at the middle of the map
const KM_PER_UNIT = 2;                        // 1 world unit = 2 km
const VIEW_HEIGHT = 32;                       // how much of the world the camera shows
const DAM_POSITION = { x: -8, z: 6 };         // fictional dam location (world units)
const TILE_RADIUS = 2.3;
const TURBINE_SLOTS = [[-1.1, -0.5], [1.1, -0.5], [0, 1.1]]; // positions on a site tile
const VISIT_SECONDS = 8;                      // length of the "visit site" fly-around
const DAYTIME_HOUR = 11;                      // lighting used outside the RUN phase

const COLORS = {
  ground: 0xd8b878, hill: 0xc49a5c, lake: 0x4fb3a5, tree: 0x6f8f3a, trunk: 0x6b4a2b,
  hut: 0xc9a26b, roof: 0x8a5a2b, tile: 0xb9c7a0, tileHover: 0xf5e08a, tileSelected: 0xffc94d,
  tower: 0xf2f2f2, blade: 0xffffff, dam: 0x9a9a9a, water: 0x3d8fc4, basin: 0x7a6a4f,
  line: 0x3a3a3a, powered: 0x49c26b, blackout: 0xd84a3a,
};

function flatMaterial(color) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

/** Convert lat/lon to a position on the map. North is -z, east is +x. */
function toWorld(place) {
  const kmEast = (place.lon - MAP_CENTER.lon) * 111.3 * Math.cos((MAP_CENTER.lat * Math.PI) / 180);
  const kmNorth = (place.lat - MAP_CENTER.lat) * 110.6;
  return new THREE.Vector3(kmEast / KM_PER_UNIT, 0, -kmNorth / KM_PER_UNIT);
}

/** Small repeatable random number generator so the scenery is the same every time. */
function makeRandom(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function makeTurbine() {
  const group = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.13, 3, 8), flatMaterial(COLORS.tower));
  tower.position.y = 1.5;
  const nacelle = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.5), flatMaterial(COLORS.tower));
  nacelle.position.set(0, 3, 0.05);
  const rotor = new THREE.Group();
  rotor.position.set(0, 3, 0.35);
  for (let i = 0; i < 3; i++) {
    const arm = new THREE.Group(); // each blade sits on its own arm, 120 degrees apart
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.5, 0.04), flatMaterial(COLORS.blade));
    blade.position.y = 0.75;
    arm.add(blade);
    arm.rotation.z = (i * 2 * Math.PI) / 3;
    rotor.add(arm);
  }
  group.add(tower, nacelle, rotor);
  group.rotation.y = Math.PI / 4; // face the camera
  group.userData.rotor = rotor;
  return group;
}

function makeVillage(random) {
  const group = new THREE.Group();
  const wallMaterial = flatMaterial(COLORS.hut);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 0.06, 20), flatMaterial(COLORS.powered));
  ring.position.y = 0.03;
  group.add(ring);
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + random();
    const distance = i === 0 ? 0 : 0.7 + random() * 0.6;
    const hut = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.4, 7), wallMaterial);
    hut.position.set(Math.cos(angle) * distance, 0.26, Math.sin(angle) * distance);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.4, 7), flatMaterial(COLORS.roof));
    roof.position.set(hut.position.x, 0.66, hut.position.z);
    group.add(hut, roof);
  }
  group.userData = { ring, wallMaterial };
  return group;
}

function makeTree(random) {
  const group = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.7, 5), flatMaterial(COLORS.trunk));
  trunk.position.y = 0.35;
  const top = new THREE.Mesh(new THREE.DodecahedronGeometry(0.45, 0), flatMaterial(COLORS.tree));
  top.scale.y = 0.45; // flat-topped, like an acacia
  top.position.y = 0.8;
  group.add(trunk, top);
  group.scale.setScalar(0.8 + random() * 0.6);
  return group;
}

function makeLabel(layer, className) {
  const element = document.createElement('div');
  element.className = `map-label ${className}`;
  layer.appendChild(element);
  return element;
}

/**
 * Build the world. Returns an object with methods the game uses to update it.
 * @param canvas     the <canvas> to draw on
 * @param labelLayer a <div> on top of the canvas for text labels
 * @param sites      list from sites.json
 * @param callbacks  { onSiteClick(siteId), onVisitEnd() }
 */
export function createWorld(canvas, labelLayer, sites, callbacks) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbfe3f0); // sky, only seen in "visit site"

  // Isometric camera for play, perspective camera for "visit site".
  const isoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
  isoCamera.position.set(40, 40, 41);
  isoCamera.lookAt(0, 0, 1);
  const visitCamera = new THREE.PerspectiveCamera(55, 1, 0.1, 300);
  let camera = isoCamera;

  const ambient = new THREE.AmbientLight(0xffffff, 0.9);
  const sun = new THREE.DirectionalLight(0xfff2d6, 1.4);
  sun.position.set(-10, 30, 15);
  scene.add(ambient, sun);

  // ---- Scenery ----
  const random = makeRandom(42);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), flatMaterial(COLORS.ground));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const lake = new THREE.Mesh(new THREE.CircleGeometry(14, 28), flatMaterial(COLORS.lake));
  lake.rotation.x = -Math.PI / 2;
  lake.scale.set(1, 2.2, 1);
  lake.position.set(-29, 0.03, -4);
  scene.add(lake);

  // Keep hills and trees away from the places the player needs to see.
  const keepClear = [
    ...sites.map((s) => toWorld(s)), ...VILLAGES.map((v) => toWorld(v)),
    new THREE.Vector3(DAM_POSITION.x, 0, DAM_POSITION.z),
  ];
  const isClear = (x, z, gap) => x > -14 && keepClear.every((p) => Math.hypot(p.x - x, p.z - z) > gap);
  for (let i = 0; i < 60; i++) {
    const x = -22 + random() * 48;
    const z = -22 + random() * 46;
    if (i < 14 && isClear(x, z, 5)) {
      const size = 0.7 + random() * 1.1;
      const hill = new THREE.Mesh(new THREE.ConeGeometry(size * 1.6, size, 6), flatMaterial(COLORS.hill));
      hill.position.set(x, size / 2, z);
      hill.rotation.y = random() * 3;
      scene.add(hill);
    } else if (i >= 14 && isClear(x, z, 3)) {
      const tree = makeTree(random);
      tree.position.set(x, 0, z);
      scene.add(tree);
    }
  }

  // ---- Dam (the water block shrinks as the drought gets worse) ----
  const dam = new THREE.Group();
  dam.position.set(DAM_POSITION.x, 0, DAM_POSITION.z);
  const basin = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.1, 3.6), flatMaterial(COLORS.basin));
  basin.position.set(-2.3, 0.05, 0);
  const water = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.3, 3.4), flatMaterial(COLORS.water));
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.7, 4), flatMaterial(COLORS.dam));
  wall.position.set(0.25, 0.85, 0);
  const powerhouse = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 1.1), flatMaterial(COLORS.dam));
  powerhouse.position.set(1, 0.35, 0);
  dam.add(basin, water, wall, powerhouse);
  scene.add(dam);
  const damLabel = makeLabel(labelLayer, 'dam-label');
  const damTop = new THREE.Vector3(DAM_POSITION.x, 2.6, DAM_POSITION.z);

  // ---- Power lines ----
  function makeLine(from, to) {
    const middle = from.clone().lerp(to, 0.5);
    const points = [from.clone().setY(1), middle.setY(0.7), to.clone().setY(1)];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: COLORS.line }));
  }

  // ---- Villages ----
  const villages = VILLAGES.map((village) => {
    const group = makeVillage(random);
    group.position.copy(toWorld(village));
    scene.add(group);
    scene.add(makeLine(new THREE.Vector3(DAM_POSITION.x + 1, 0, DAM_POSITION.z), group.position));
    const label = makeLabel(labelLayer, 'village-label');
    label.textContent = village.name;
    return { group, label, anchor: group.position.clone().setY(1.6) };
  });

  // ---- Wind sites ----
  const siteObjects = {};
  const tiles = [];
  for (const site of sites) {
    const position = toWorld(site);
    const tile = new THREE.Mesh(
      new THREE.CylinderGeometry(TILE_RADIUS, TILE_RADIUS, 0.16, 6), flatMaterial(COLORS.tile));
    tile.position.copy(position).setY(0.08);
    tile.userData.siteId = site.id;
    scene.add(tile);
    tiles.push(tile);
    const line = makeLine(position, toWorld(nearestVillage(site)));
    line.visible = false;
    scene.add(line);
    siteObjects[site.id] = {
      position, tile, line, turbines: [], wind: site.meanWind,
      label: makeLabel(labelLayer, 'site-label'),
      anchor: new THREE.Vector3(position.x + 1.7, 0, position.z + 1.7), // just in front of the tile
    };
  }

  // ---- Mouse picking ----
  let hoveredId = null;
  let selectedId = null;
  let sitesClickable = false;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function siteUnderPointer(event) {
    const box = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - box.left) / box.width) * 2 - 1;
    pointer.y = -((event.clientY - box.top) / box.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(tiles)[0];
    return hit ? hit.object.userData.siteId : null;
  }

  function refreshTileColors() {
    for (const id in siteObjects) {
      let color = COLORS.tile;
      if (id === hoveredId && sitesClickable) color = COLORS.tileHover;
      if (id === selectedId) color = COLORS.tileSelected;
      siteObjects[id].tile.material.color.setHex(color);
    }
  }

  canvas.addEventListener('pointermove', (event) => {
    if (visit) return;
    hoveredId = siteUnderPointer(event);
    canvas.style.cursor = hoveredId && sitesClickable ? 'pointer' : 'default';
    refreshTileColors();
  });
  canvas.addEventListener('click', (event) => {
    if (visit) { stopVisit(); return; } // click anywhere to end the fly-around
    const id = siteUnderPointer(event);
    if (id && sitesClickable) callbacks.onSiteClick(id);
  });

  // ---- Visit site (ground-level fly-around) ----
  let visit = null;
  function stopVisit() {
    if (!visit) return;
    visit = null;
    camera = isoCamera;
    labelLayer.style.visibility = 'visible';
    callbacks.onVisitEnd();
  }

  // ---- Sizing ----
  function resize() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    const aspect = width / height;
    const viewHeight = Math.max(VIEW_HEIGHT, 42 / aspect); // keep the whole map visible on narrow screens
    isoCamera.left = (-viewHeight * aspect) / 2;
    isoCamera.right = (viewHeight * aspect) / 2;
    isoCamera.top = viewHeight / 2;
    isoCamera.bottom = -viewHeight / 2;
    isoCamera.updateProjectionMatrix();
    visitCamera.aspect = aspect;
    visitCamera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  const projected = new THREE.Vector3();
  function placeLabel(element, anchor) {
    projected.copy(anchor).project(camera);
    const x = (projected.x * 0.5 + 0.5) * canvas.clientWidth;
    const y = (-projected.y * 0.5 + 0.5) * canvas.clientHeight;
    element.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  // ---- Public methods ----
  return {
    /** Show the right number of turbines on every site. turbines = { siteId: count } */
    setTurbines(turbines) {
      for (const id in siteObjects) {
        const site = siteObjects[id];
        const wanted = Math.min(turbines[id] || 0, MAX_TURBINES_PER_SITE);
        while (site.turbines.length < wanted) {
          const turbine = makeTurbine();
          const [dx, dz] = TURBINE_SLOTS[site.turbines.length];
          turbine.position.set(site.position.x + dx, 0.16, site.position.z + dz);
          turbine.userData.rotor.rotation.z = Math.random() * 6;
          scene.add(turbine);
          site.turbines.push(turbine);
        }
        while (site.turbines.length > wanted) scene.remove(site.turbines.pop());
        site.line.visible = wanted > 0;
      }
    },

    /** Wind speed (m/s) per site: controls how fast the blades spin. */
    setWind(windBySite) {
      for (const id in siteObjects) if (windBySite[id] !== undefined) siteObjects[id].wind = windBySite[id];
    },

    /** Drought visual: lower the water behind the dam. fraction = 0..1 */
    setReservoir(fraction) {
      water.scale.y = Math.max(fraction, 0.02);
      water.position.set(-2.3, 0.1 + (1.3 * water.scale.y) / 2, 0);
      damLabel.textContent = `Hydro dam · reservoir ${Math.round(fraction * 100)}%`;
    },

    /** Light or darken each village. villagesOn = [true/false per village] */
    setVillagesOn(villagesOn) {
      villages.forEach((village, i) => {
        const on = villagesOn[i];
        village.group.userData.ring.material.color.setHex(on ? COLORS.powered : COLORS.blackout);
        village.group.userData.wallMaterial.emissive.setHex(on ? 0xffb347 : 0x000000);
        village.group.userData.wallMaterial.color.setHex(on ? COLORS.hut : 0x4a4038);
        village.label.classList.toggle('off', !on);
      });
    },

    /** Day/night lighting. hour = 0..24 (fractions allowed). */
    setHour(hour) {
      const daylight = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
      ambient.intensity = 0.3 + 0.6 * daylight;
      sun.intensity = 0.15 + 1.25 * daylight;
      // House lights glow more at night.
      for (const village of villages) village.group.userData.wallMaterial.emissiveIntensity = 0.9 - 0.75 * daylight;
    },
    setDaytime() { this.setHour(DAYTIME_HOUR); },

    setSitesClickable(clickable) { sitesClickable = clickable; refreshTileColors(); },
    setSelectedSite(siteId) { selectedId = siteId; refreshTileColors(); },
    setSiteLabel(siteId, html) { siteObjects[siteId].label.innerHTML = html; },

    /** Start the ground-level camera circling a site. */
    visitSite(siteId) {
      visit = { center: siteObjects[siteId].position, time: 0 };
      camera = visitCamera;
      labelLayer.style.visibility = 'hidden';
    },
    stopVisit,

    /** Call once per frame. dt = seconds since the last frame. */
    update(dt) {
      for (const id in siteObjects) {
        const site = siteObjects[id];
        const spinning = site.wind >= CUT_IN_MS && site.wind <= CUT_OUT_MS;
        const speed = spinning ? 0.6 + 3.4 * Math.min(site.wind / RATED_MS, 1) : 0;
        for (const turbine of site.turbines) turbine.userData.rotor.rotation.z -= speed * dt;
      }

      if (visit) {
        visit.time += dt;
        const angle = 0.6 + visit.time * 0.45;
        visitCamera.position.set(
          visit.center.x + Math.cos(angle) * 8, 1.2 + visit.time * 0.12, visit.center.z + Math.sin(angle) * 8);
        visitCamera.lookAt(visit.center.x, 2.4, visit.center.z);
        if (visit.time > VISIT_SECONDS) stopVisit();
      } else {
        for (const id in siteObjects) placeLabel(siteObjects[id].label, siteObjects[id].anchor);
        for (const village of villages) placeLabel(village.label, village.anchor);
        placeLabel(damLabel, damTop);
      }
      renderer.render(scene, camera);
    },
    resize,
  };
}
