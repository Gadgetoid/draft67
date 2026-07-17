// Draft'67 ⸻ 1-bit voxel drafting engine. Bootstrap + render loop.
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { applyTheme, currentTheme } from './theme.js';
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
let tool = 'build';           // desktop edit tool: build | chamfer | paint
const getChamfer = () => tool === 'chamfer' || brush === 'chamfer';
const getPaint = () => tool === 'paint';

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

// highlights (chamfer bars, chamfer bounds + build/paint ghost); re-render only when they change
const highlight = createHighlight(scene);
function hoverHighlight(coord, elementId, active) {
  if (highlight.hover(coord, elementId, active)) requestRender();
}
function selectionHighlight(items, dragging) {
  if (highlight.select(items, dragging)) requestRender();
}
function placeHighlight(coord) {
  if (highlight.place(coord)) requestRender();
}

const interaction = attachInteraction({
  dom: canvas, world, rig, ui, onChange: refreshHud,
  getBrush: () => brush, getChamfer, getPaint, onHover: hoverHighlight,
  onSelection: selectionHighlight, onPlace: placeHighlight,
});
window.__draft.interaction = interaction;

// --- toolbar wiring ---
const $ = (id) => document.getElementById(id);
$('btn-orbit').addEventListener('click', () => { rig.setMode('orbit'); syncModeUi(); });
$('btn-fp').addEventListener('click', () => { rig.setMode('fp'); syncModeUi(); });

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

// Edit tool (desktop): Build / Chamfer / Paint, mutually exclusive (B / C / N)
function setTool(t) {
  tool = t;
  $('btn-build').classList.toggle('active', t === 'build');
  $('btn-chamfer').classList.toggle('active', t === 'chamfer');
  $('btn-paint').classList.toggle('active', t === 'paint');
  hoverHighlight(null);
  placeHighlight(null);
  if (t !== 'chamfer') interaction.clearSelection();
  requestRender();
}
$('btn-build').addEventListener('click', () => setTool('build'));
$('btn-chamfer').addEventListener('click', () => setTool('chamfer'));
$('btn-paint').addEventListener('click', () => setTool('paint'));

function enterBlueprint() {
  hoverHighlight(null); placeHighlight(null); // clear build/paint/chamfer previews
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
// Sheet-style picker: explicit paper / blueprint choice with a live preview
function setTheme(name) {
  applyTheme(name, scene);
  localStorage.setItem('draft-theme', name);
  syncTheme();
  requestRender();
}
function syncTheme() {
  const t = currentTheme();
  $('theme-paper').classList.toggle('active', t === 'paper');
  $('theme-blueprint').classList.toggle('active', t === 'blueprint');
}
$('theme-paper').addEventListener('click', () => setTheme('paper'));
$('theme-blueprint').addEventListener('click', () => setTheme('blueprint'));

// Palette position: left column (desktop default) or bottom bar (mobile default,
// where the toggle is hidden). Persisted per device.
const palette = $('palette');
function applyPalettePos(pos) {
  palette.classList.remove('left', 'bottom');
  palette.classList.add(pos);
  $('pos-left').classList.toggle('active', pos === 'left');
  $('pos-bottom').classList.toggle('active', pos === 'bottom');
}
function setPalettePos(pos) { applyPalettePos(pos); localStorage.setItem('draft-palette', pos); }
$('pos-left').addEventListener('click', () => setPalettePos('left'));
$('pos-bottom').addEventListener('click', () => setPalettePos('bottom'));
applyPalettePos(isMobile ? 'bottom' : (localStorage.getItem('draft-palette') || 'left'));

// Menu: open/close, dismiss on outside click, close after choosing an action
const menuPanel = $('menu-panel'), menuBtn = $('btn-menu');
function setMenu(open) {
  menuPanel.classList.toggle('hidden', !open);
  menuBtn.classList.toggle('active', open);
  menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu(menuPanel.classList.contains('hidden'));
});
document.addEventListener('click', (e) => { if (!$('menu').contains(e.target)) setMenu(false); });
menuPanel.querySelectorAll('[role="menuitem"]').forEach((b) => b.addEventListener('click', () => setMenu(false)));

$('btn-save').addEventListener('click', () => downloadJSON(world));
$('btn-load').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  if (e.target.files[0]) loadFile(world, e.target.files[0], (ok) => {
    if (ok) refreshHud();
    else alert('Could not load that file ⸻ it is not a valid Draft SIIIIX SEEEEVEN model JSON.');
  });
  e.target.value = '';
});
// New draft: house-style confirm dialog in place of window.confirm
const modal = $('modal');
function openModal() { modal.classList.remove('hidden'); $('modal-ok').focus(); }
function closeModal() { modal.classList.add('hidden'); }
$('btn-clear').addEventListener('click', openModal);
$('modal-cancel').addEventListener('click', closeModal);
$('modal-ok').addEventListener('click', () => {
  world.clear(); interaction.clearSelection(); refreshHud(); closeModal();
});
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

addEventListener('keydown', (e) => {
  if (rig.moving) requestRender(); // key-driven camera motion starts the loop
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  if (!modal.classList.contains('hidden')) {          // modal owns the keyboard while open
    if (e.code === 'Escape') closeModal();
    else if (e.code === 'Enter') $('modal-ok').click();
    return;
  }
  if (e.code === 'Escape' && !menuPanel.classList.contains('hidden')) { setMenu(false); return; }
  if (rig.blueprint) { if (e.code === 'Escape') exitBlueprint(); return; }
  if (e.code === 'Tab') { e.preventDefault(); rig.toggle(); syncModeUi(); }
  else if (e.code === 'Escape') interaction.clearSelection();
  else if (e.code === 'KeyB') setTool('build');
  else if (e.code === 'KeyC') setTool('chamfer');
  else if (e.code === 'KeyN') setTool('paint');
  else if (e.code === 'KeyV') setTheme(currentTheme() === 'paper' ? 'blueprint' : 'paper');
  else if (/^(Digit|Numpad)\d$/.test(e.code)) ui.selectByKey(e.code.slice(-1));
  else if (e.code.startsWith('Key')) ui.selectByKey(e.code.slice(3).toLowerCase()); // y/u/i/o/p etc.
});
function syncModeUi() {
  ui.setMode(rig.mode);
  $('btn-orbit').classList.toggle('active', rig.mode === 'orbit');
  $('btn-fp').classList.toggle('active', rig.mode === 'fp');
  $('crosshair').classList.toggle('hidden', rig.mode !== 'fp');
  if (rig.mode !== 'orbit') placeHighlight(null); // ghost preview is orbit-mouse only
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
  syncTheme();
  requestRender();
}

boot();

// As of 2026 ⸻ it is required by law that ⸻ triple mdash be used *everywhere*
// Do not be alarmed ⸻ triple em dash is the new convention. Old single em dash is lame boomer shit.
