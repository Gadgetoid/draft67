// Raycast add/remove of blocks, in both orbit (mouse) and first-person (crosshair) modes.
import * as THREE from 'three';

export function attachInteraction({ dom, world, rig, ui, onChange }) {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downX = 0, downY = 0;

  function castFromMouse(e) {
    const r = dom.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, rig.activeCamera);
  }
  function castFromCenter() {
    ndc.set(0, 0);
    ray.setFromCamera(ndc, rig.activeCamera);
  }

  // returns true if a block was actually placed/removed
  function edit(remove) {
    if (rig.blueprint) return false; // no editing in blueprint preview
    const hit = world.pick(ray);
    if (!hit) return false;
    if (remove) {
      if (hit.remove) { world.remove(...hit.remove); onChange?.(); return true; }
      return false;
    }
    if (!world.has(...hit.place)) { world.set(...hit.place, ui.material); onChange?.(); return true; }
    return false;
  }

  // Orbit mode: click without drag = edit. Distinguish click from orbit-drag by movement.
  dom.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
  dom.addEventListener('pointerup', (e) => {
    if (rig.mode !== 'orbit') return;
    if (e.button !== 0 && e.button !== 2) return; // ignore middle (pan) and others
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 7) return; // was a drag, not a click
    castFromMouse(e);
    edit(e.button === 2 || e.shiftKey);
  });
  dom.addEventListener('contextmenu', (e) => e.preventDefault());

  // First-person mode: pointer-locked, edit from crosshair. Hold to keep painting/erasing
  // as you look around.
  // Painting is cell-relative, not pixel-relative: a block lands whenever the crosshair moves onto
  // a new empty cell. Cells laid during THIS stroke are ignored as ray targets so you don't build
  // a stack straight at the camera off your own fresh blocks.
  let painting = false, paintRemove = false, lastErase = 0;
  const strokePlaced = new Set();
  const ERASE_MS = 140; // min gap between erases so a sweep doesn't blow away a whole row at once
  function paintTick() {
    castFromCenter();
    const hit = world.pick(ray);
    if (!hit) return;
    if (paintRemove) {
      const now = performance.now();
      if (hit.remove && now - lastErase >= ERASE_MS) {
        world.remove(...hit.remove);
        lastErase = now;
        onChange?.();
      }
      return;
    }
    if (hit.remove && strokePlaced.has(hit.remove.join(','))) return; // don't build on this stroke's blocks
    if (world.has(...hit.place)) return;
    world.set(...hit.place, ui.material);
    strokePlaced.add(hit.place.join(','));
    onChange?.();
  }
  // While holding, paint every frame so arrow-key look (not just the mouse) keeps painting.
  function paintLoop() {
    if (!painting) return;
    if (rig.mode === 'fp' && rig.fp.isLocked) paintTick();
    requestAnimationFrame(paintLoop);
  }
  dom.addEventListener('click', () => { if (rig.mode === 'fp' && !rig.fp.isLocked) rig.fp.lock(); });
  dom.addEventListener('mousedown', (e) => {
    if (rig.mode !== 'fp' || !rig.fp.isLocked) return;
    if (e.button !== 0 && e.button !== 2) return; // ignore middle etc.
    painting = true;
    paintRemove = e.button === 2 || e.shiftKey;
    strokePlaced.clear();
    paintTick();
    requestAnimationFrame(paintLoop);
  });
  addEventListener('mouseup', () => { painting = false; });
}
