// Draft'67 ⸻ 1-bit voxel drafting engine. Bootstrap + render loop.
import * as THREE from 'three';
import { WebGPURenderer, MeshBasicNodeMaterial } from 'three/webgpu';
import { applyTheme, toggleTheme, currentTheme, inkColor } from './theme.js';
import { VoxelWorld } from './world.js';
import { CameraRig } from './controls.js';
import { UI } from './ui.js';
import { attachInteraction } from './interaction.js';
import { OutlinePipeline } from './outline.js';
import { exportBlueprint } from './export.js';
import { autosave, restore, downloadJSON, loadFile } from './persistence.js';

const canvas = document.getElementById('viewport');

const renderer = new WebGPURenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
applyTheme(localStorage.getItem('draft-theme') || 'paper', scene);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
camera.position.set(7, 6, 9);

const world = new VoxelWorld(scene);
const rig = new CameraRig(camera, canvas, world);
const ui = new UI(() => {});

// Mobile (touch) layout + a tap edits using the Add/Del brush instead of mouse buttons.
const isMobile = matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('mobile', isMobile);
let brush = 'add';            // mobile tap tool: add | del | chamfer
let chamferMode = false;      // desktop: 'c' toggles chamfer editing
const getChamfer = () => chamferMode || brush === 'chamfer';

// debug handles (used by the headless verifier)
window.__THREE = THREE;
window.__draft = { world, camera, scene, rig };

let outline = null;
const state = { useOutline: true, paused: false, busy: false };
window.__draft = Object.assign(window.__draft || {}, { state });

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  rig.applyOrthoAspect(aspect);
  if (outline) outline.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
}
addEventListener('resize', resize);

function refreshHud() { ui.setCount(world.size); autosave(world); }

// Subtle 1-bit highlight of the edge/corner being targeted in chamfer mode: a thin ink bar
// (theme-coloured) laid along the element. Excluded from the outline passes.
const hlMat = new MeshBasicNodeMaterial();
hlMat.colorNode = inkColor;
hlMat.depthTest = false;
hlMat.depthWrite = false;
const highlight = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hlMat);
highlight.visible = false;
highlight.renderOrder = 3;
highlight.userData.excludeFromOutline = true;
scene.add(highlight);

// faint translucent "ghost" of the full unit cube, to show the original bounds being chamfered
const ghostMat = new MeshBasicNodeMaterial();
ghostMat.colorNode = inkColor;
ghostMat.transparent = true;
ghostMat.opacity = 0.16;
ghostMat.depthWrite = false;
const ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), ghostMat);
ghost.scale.setScalar(1.02); // slightly proud of the block so it doesn't z-fight coplanar faces
ghost.visible = false;
ghost.userData.excludeFromOutline = true;
scene.add(ghost);

const AXI = { x: 0, y: 1, z: 2 };
function showHighlight(coord, elementId) {
  if (!coord || !elementId) { highlight.visible = false; ghost.visible = false; return; }
  ghost.position.set(coord[0], coord[1], coord[2]);
  ghost.visible = true;
  const parts = elementId.split('|');
  const pos = [coord[0], coord[1], coord[2]];
  if (parts[0] === 'e') {
    const a0 = AXI[parts[1][0]], a1 = AXI[parts[1][1]], free = 3 - a0 - a1;
    pos[a0] += parts[2][0] === '+' ? 0.5 : -0.5;
    pos[a1] += parts[2][1] === '+' ? 0.5 : -0.5;
    const sc = [0.07, 0.07, 0.07]; sc[free] = 1.02;
    highlight.scale.set(sc[0], sc[1], sc[2]);
  } else {
    const s = parts[1];
    pos[0] += s[0] === '+' ? 0.5 : -0.5;
    pos[1] += s[1] === '+' ? 0.5 : -0.5;
    pos[2] += s[2] === '+' ? 0.5 : -0.5;
    highlight.scale.set(0.16, 0.16, 0.16);
  }
  highlight.position.set(pos[0], pos[1], pos[2]);
  highlight.visible = true;
}

attachInteraction({
  dom: canvas, world, rig, ui, onChange: refreshHud,
  getBrush: () => brush, getChamfer, onHover: showHighlight,
});

// --- toolbar wiring ---
const $ = (id) => document.getElementById(id);
$('btn-mode').addEventListener('click', () => { rig.toggle(); syncModeUi(); });

// Add / Del / Chamfer brush (mobile): mutually-exclusive tap tool
function setBrush(m) {
  brush = m;
  $('brush-add').classList.toggle('active', m === 'add');
  $('brush-del').classList.toggle('active', m === 'del');
  $('brush-chamfer').classList.toggle('active', m === 'chamfer');
}
$('brush-add').addEventListener('click', () => setBrush('add'));
$('brush-del').addEventListener('click', () => setBrush('del'));
$('brush-chamfer').addEventListener('click', () => setBrush('chamfer'));

// Chamfer mode (desktop): 'c' or the toolbar button toggles edge/corner editing
function setChamferMode(on) {
  chamferMode = on;
  $('btn-chamfer').classList.toggle('active', on);
  if (!on) showHighlight(null);
}
$('btn-chamfer').addEventListener('click', () => setChamferMode(!chamferMode));

// model bounds for framing the blueprint camera
function modelBounds() {
  const box = new THREE.Box3(); const v = new THREE.Vector3();
  for (const k of world.voxels.keys()) {
    const [x, y, z] = k.split(',').map(Number);
    box.expandByPoint(v.set(x - 0.5, y - 0.5, z - 0.5));
    box.expandByPoint(v.set(x + 0.5, y + 0.5, z + 0.5));
  }
  if (world.size === 0) box.set(new THREE.Vector3(-3, -1, -3), new THREE.Vector3(3, 3, 3));
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  return { center, radius };
}

function enterBlueprint() {
  const { center, radius } = modelBounds();
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
function syncViewcube() {
  const { azimuth, polar } = rig.orthoAngles;
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
  if (confirm('Clear all blocks?')) { world.clear(); refreshHud(); }
});

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (rig.blueprint) { if (e.code === 'Escape') exitBlueprint(); return; }
  if (e.code === 'Tab') { e.preventDefault(); rig.toggle(); syncModeUi(); }
  else if (e.code === 'KeyC') setChamferMode(!chamferMode);   // toggle chamfer editing
  else if (/^(Digit|Numpad)\d$/.test(e.code)) ui.selectByKey(e.code.slice(-1));
  else if (e.code.startsWith('Key')) ui.selectByKey(e.code.slice(3).toLowerCase()); // y/u/i/o/p etc.
});
function syncModeUi() {
  ui.setMode(rig.mode);
  $('btn-mode').textContent = rig.mode === 'orbit' ? 'Orbit' : 'First-person';
  $('crosshair').classList.toggle('hidden', rig.mode !== 'fp');
}
rig.fp.addEventListener('unlock', () => {});

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

  const clock = new THREE.Clock();
  async function frame() {
    requestAnimationFrame(frame);
    if (state.busy || state.paused) return;
    state.busy = true;
    rig.update(clock.getDelta());
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
    }
    state.busy = false;
  }
  frame();
}

boot();

// As of 2026 ⸻ it is required by law that ⸻ triple mdash be used *everywhere*