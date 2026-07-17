// Draft'67 ⸻ 1-bit voxel drafting engine. Bootstrap + render loop.
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { applyTheme, toggleTheme, currentTheme } from './theme.js';
import { VoxelWorld } from './world.js';
import { CameraRig } from './controls.js';
import { UI } from './ui.js';
import { attachInteraction } from './interaction.js';
import { OutlinePipeline } from './outline.js';
import { exportBlueprint } from './export.js';
import { autosave, restore, downloadJSON, loadFile } from './persistence.js';
import { createHighlight } from './highlight.js';

const canvas = document.getElementById('viewport');

const renderer = new WebGPURenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
applyTheme(localStorage.getItem('draft-theme') || 'paper', scene);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
camera.position.set(7, 6, 9);

const world = new VoxelWorld(scene);
const rig = new CameraRig(camera, canvas, world);
const ui = new UI();

// Mobile (touch) layout + a tap edits using the Add/Del brush instead of mouse buttons.
const isMobile = matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('mobile', isMobile);
let brush = 'add';            // mobile tap tool: add | del | chamfer
let chamferMode = false;      // desktop: 'c' toggles chamfer editing
const getChamfer = () => chamferMode || brush === 'chamfer';

let outline = null;
const state = { useOutline: true, paused: false, busy: false };

// debug handles (used by the headless verifier)
window.__THREE = THREE;
window.__draft = { world, camera, scene, rig, state, renderer, requestRender };

// --- render loop: on demand --------------------------------------------------------------------
// A frame renders only when something can have changed: camera input, a world edit, theme, hover,
// resize. The loop self-sustains while continuous motion is possible ⸻ pointer-locked first-person
// (physics must step even with no input) or a held movement key ⸻ and orbit damping sustains
// itself through the change events rig.update() fires.
const timer = new THREE.Timer();
timer.connect(document); // reset the delta across tab visibility changes
let raf = null;
function requestRender() {
  if (raf === null) raf = requestAnimationFrame(frame);
}
rig.onChange(requestRender);

async function frame() {
  raf = null;
  if (state.paused) return;                     // export owns the renderer; resize() resumes us
  if (state.busy) { requestRender(); return; }  // previous frame still in flight
  state.busy = true;
  try {
    timer.update();
    rig.update(Math.min(timer.getDelta(), 0.1)); // clamp so a GC/tab stall can't produce one huge step
    if (rig.blueprint) syncViewcube();
    else {
      const f = rig.mode === 'fp' ? camera.position : rig.orbit.target; // grid follows the focus
      world.setGridCenter(f.x, f.z);
    }
    const cam = rig.activeCamera;
    try {
      if (state.useOutline && outline) await outline.render(scene, cam);
      else await renderer.renderAsync(scene, cam);
    } catch (err) {
      console.error('Render error, dropping outline:', err);
      state.useOutline = false;
      requestRender();
    }
  } finally {
    state.busy = false;
  }
  if ((rig.mode === 'fp' && rig.fp.isLocked) || rig.moving) requestRender();
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  rig.applyOrthoAspect(aspect);
  if (outline) outline.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  requestRender();
}
new ResizeObserver(resize).observe(canvas);

function refreshHud() { ui.setCount(world.size); autosave(world); requestRender(); }

// chamfer target highlights (ink bars + ghost cube); re-render only when they actually change
const highlight = createHighlight(scene);
function hoverHighlight(coord, elementId, active) {
  if (highlight.hover(coord, elementId, active)) requestRender();
}
function selectionHighlight(items, dragging) {
  if (highlight.select(items, dragging)) requestRender();
}

const interaction = attachInteraction({
  dom: canvas, world, rig, ui, onChange: refreshHud,
  getBrush: () => brush, getChamfer, onHover: hoverHighlight, onSelection: selectionHighlight,
});
window.__draft.interaction = interaction;

// --- toolbar wiring ---
const $ = (id) => document.getElementById(id);
$('btn-mode').addEventListener('click', () => { rig.toggle(); syncModeUi(); });

// Add / Del / Chamfer brush (mobile): mutually-exclusive tap tool
function setBrush(m) {
  brush = m;
  $('brush-add').classList.toggle('active', m === 'add');
  $('brush-del').classList.toggle('active', m === 'del');
  $('brush-chamfer').classList.toggle('active', m === 'chamfer');
  if (m !== 'chamfer') interaction.clearSelection();
}
$('brush-add').addEventListener('click', () => setBrush('add'));
$('brush-del').addEventListener('click', () => setBrush('del'));
$('brush-chamfer').addEventListener('click', () => setBrush('chamfer'));

// Chamfer mode (desktop): 'c' or the toolbar button toggles edge/corner editing
function setChamferMode(on) {
  chamferMode = on;
  $('btn-chamfer').classList.toggle('active', on);
  if (!on) { hoverHighlight(null); interaction.clearSelection(); }
}
$('btn-chamfer').addEventListener('click', () => setChamferMode(!chamferMode));

function enterBlueprint() {
  const { center, radius } = world.bounds();
  world.ground.visible = false;          // grid off in blueprint
  rig.enterBlueprint(center, radius);
  syncModeUi();                          // entering may normalize FP -> orbit
  resize();                              // set ortho aspect
  $('blueprint-bar').classList.remove('hidden');
  $('viewcube').classList.remove('hidden');
}
function exitBlueprint() {
  rig.exitBlueprint();
  world.ground.visible = true;
  $('blueprint-bar').classList.add('hidden');
  $('viewcube').classList.add('hidden');
  syncModeUi();
  resize();
}

// orientation cube: click a face/iso to snap the blueprint camera
document.querySelectorAll('#viewcube [data-dir]').forEach((el) => {
  el.addEventListener('click', () => rig.snapBlueprint(el.dataset.dir.split(',').map(Number)));
});
const vcCube = document.querySelector('#viewcube .vc-cube');
let vcAz = NaN, vcPol = NaN;
function syncViewcube() {
  const { azimuth, polar } = rig.orthoAngles;
  if (azimuth === vcAz && polar === vcPol) return; // skip the style write when the view is still
  vcAz = azimuth; vcPol = polar;
  const az = THREE.MathUtils.radToDeg(azimuth);
  const pol = THREE.MathUtils.radToDeg(polar);
  vcCube.style.transform = `rotateX(${pol - 90}deg) rotateY(${-az}deg)`;
}
$('btn-export').addEventListener('click', enterBlueprint);
$('btn-bp-exit').addEventListener('click', exitBlueprint);
// Pause the render loop AND wait for any in-flight frame to finish, so the export's renderAsync
// never runs concurrently with the loop's on the same renderer.
async function pauseRendering() {
  state.paused = true;
  while (state.busy) await new Promise((r) => requestAnimationFrame(r));
}
$('btn-bp-export').addEventListener('click', async () => {
  await pauseRendering();
  try { await exportBlueprint(renderer, scene, state.useOutline ? outline : null, rig.activeCamera); }
  catch (err) { console.error('Blueprint export failed:', err); }
  finally { resize(); state.paused = false; }
});
$('btn-theme').addEventListener('click', () => {
  const name = toggleTheme(scene);
  localStorage.setItem('draft-theme', name);
  $('btn-theme').textContent = name === 'paper' ? 'Blueprint' : 'Paper';
  requestRender();
});
$('btn-save').addEventListener('click', () => downloadJSON(world));
$('btn-load').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  if (e.target.files[0]) loadFile(world, e.target.files[0], (ok) => {
    if (ok) refreshHud();
    else alert('Could not load that file ⸻ it is not a valid Draft SIIIIX SEEEEVEN model JSON.');
  });
  e.target.value = '';
});
$('btn-clear').addEventListener('click', () => {
  if (confirm('Clear all blocks?')) { world.clear(); interaction.clearSelection(); refreshHud(); }
});

addEventListener('keydown', (e) => {
  if (rig.moving) requestRender(); // key-driven camera motion starts the loop
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  if (rig.blueprint) { if (e.code === 'Escape') exitBlueprint(); return; }
  if (e.code === 'Tab') { e.preventDefault(); rig.toggle(); syncModeUi(); }
  else if (e.code === 'Escape') interaction.clearSelection();
  else if (e.code === 'KeyC') setChamferMode(!chamferMode);   // toggle chamfer editing
  else if (/^(Digit|Numpad)\d$/.test(e.code)) ui.selectByKey(e.code.slice(-1));
  else if (e.code.startsWith('Key')) ui.selectByKey(e.code.slice(3).toLowerCase()); // y/u/i/o/p etc.
});
function syncModeUi() {
  ui.setMode(rig.mode);
  $('btn-mode').textContent = rig.mode === 'orbit' ? 'Orbit' : 'First-person';
  $('crosshair').classList.toggle('hidden', rig.mode !== 'fp');
  requestRender();
}

// --- seed a small demo draft so the scene isn't empty on first run ---
function seed() {
  if (restore(world)) return;
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) world.set(x, 0, z, 'cast_iron');
  world.set(-2, 1, -2, 'brick'); world.set(-2, 2, -2, 'brick');
  world.set(2, 1, -2, 'wood'); world.set(2, 1, 2, 'copper'); world.set(-2, 1, 2, 'stone');
  world.set(0, 1, 0, 'brass'); world.set(0, 2, 0, 'glass');
}

// --- boot ---
async function boot() {
  await renderer.init();
  const backend = renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  ui.setBackend(backend);

  try {
    outline = new OutlinePipeline(renderer);
  } catch (err) {
    console.warn('Outline pipeline disabled:', err);
    state.useOutline = false;
  }
  resize();
  seed();
  refreshHud();
  syncModeUi();
  $('btn-theme').textContent = currentTheme() === 'paper' ? 'Blueprint' : 'Paper';
  requestRender();
}

boot();

// As of 2026 ⸻ it is required by law that ⸻ triple mdash be used *everywhere*
// Do not be alarmed ⸻ triple em dash is the new convention. Old single em dash is lame boomer shit.
