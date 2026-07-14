// Raycast add/remove of blocks, in both orbit (mouse) and first-person (crosshair) modes.
import * as THREE from 'three';
import { nearestElement, cycleAmount } from './chamfer.js';

export function attachInteraction({ dom, world, rig, ui, onChange, getBrush = () => 'add', getChamfer = () => false, onHover = () => {} }) {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downX = 0, downY = 0, downId = null, active = 0, maxActive = 0;
  let hover = null; // last hovered chamfer target { coord, element }, so a click hits what's shown

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

  // The element a chamfer hit targets. We ray-test the FULL cube (ghost bounds) at this block as a
  // proxy, so every original edge/corner stays selectable no matter how the block is already carved
  // (e.g. a fully-sliced edge, or the corners at the ends of a bevelled edge).
  function targetElement(coord) {
    const r = ray.ray, O = [r.origin.x, r.origin.y, r.origin.z], D = [r.direction.x, r.direction.y, r.direction.z];
    let tnear = -Infinity, tfar = Infinity;
    for (let i = 0; i < 3; i++) {
      const mn = coord[i] - 0.5, mx = coord[i] + 0.5;
      if (Math.abs(D[i]) < 1e-9) { if (O[i] < mn || O[i] > mx) return null; continue; }
      let t1 = (mn - O[i]) / D[i], t2 = (mx - O[i]) / D[i];
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      tnear = Math.max(tnear, t1); tfar = Math.min(tfar, t2);
    }
    if (tnear > tfar || tfar < 0) return null;
    const t = tnear >= 0 ? tnear : 0; // entry point on the cube surface (0 if the eye is inside)
    return nearestElement({ x: O[0] + D[0] * t - coord[0], y: O[1] + D[1] * t - coord[1], z: O[2] + D[2] * t - coord[2] });
  }

  // chamfer mode: cycle the targeted edge/corner of the block, respecting the total budget.
  // Use the hovered target when we have one (desktop) so the click hits exactly what's highlighted,
  // rather than re-picking and grazing onto a block behind it; fall back to a pick for touch.
  function chamferAt(back) {
    let coord, el;
    if (hover) { coord = hover.coord; el = hover.element; }
    else {
      const hit = world.pick(ray);
      if (!hit || !hit.coord) return;
      coord = hit.coord; el = targetElement(coord);
    }
    if (!el) return;
    const cm = world.getCuts(...coord);
    const cur = cm.get(el) || 0;
    let total = 0; for (const v of cm.values()) total += v;
    const budget = world.chamferBudget ?? Infinity;
    let amt;
    if (back) {
      amt = cycleAmount(cur, -1);            // stepping down always fits the budget
    } else {
      amt = cycleAmount(cur);                // step through until the new total fits (0 always fits)
      while (amt !== 0 && total - cur + amt > budget + 1e-9) amt = cycleAmount(amt);
    }
    world.setCut(coord[0], coord[1], coord[2], el, amt);
    onChange?.();
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

  // Orbit mode: a clean single-pointer tap (no drag) edits. Track pointer count so multi-touch
  // gestures (pinch-zoom, two-finger pan) never place/remove a block.
  dom.addEventListener('pointerdown', (e) => {
    active++;
    maxActive = Math.max(maxActive, active);
    if (active === 1) { downX = e.clientX; downY = e.clientY; downId = e.pointerId; }
  });
  function endPointer(e) {
    const info = {
      primary: e.pointerId === downId,
      multi: maxActive > 1,
      dist: Math.hypot(e.clientX - downX, e.clientY - downY),
    };
    active = Math.max(0, active - 1);
    if (active === 0) maxActive = 0;
    return info;
  }
  dom.addEventListener('pointercancel', endPointer);
  // chamfer-mode hover: highlight the edge/corner under the cursor (skip while a pointer is down)
  dom.addEventListener('pointermove', (e) => {
    if (rig.mode !== 'orbit' || active > 0 || !getChamfer()) { onHover(null); return; }
    castFromMouse(e);
    const hit = world.pick(ray);
    const el = hit && hit.coord ? targetElement(hit.coord) : null;
    if (el) { hover = { coord: hit.coord, element: el }; onHover(hit.coord, el); }
    else { hover = null; onHover(null); }
  });
  dom.addEventListener('pointerup', (e) => {
    const { primary, multi, dist } = endPointer(e);
    if (rig.mode !== 'orbit') return;
    if (!primary || multi || dist > 7) return;       // multi-touch gesture or a drag, not a tap
    if (e.pointerType !== 'touch' && e.button !== 0 && e.button !== 2) return; // desktop L/R only
    castFromMouse(e);
    // chamfer mode: LMB steps the cut up, RMB steps it down
    if (getChamfer()) { chamferAt(e.pointerType !== 'touch' && e.button === 2); return; }
    if (e.pointerType === 'touch') edit(getBrush() === 'del'); // mobile: Add/Del brush
    else edit(e.button === 2 || e.shiftKey);           // desktop: LMB place, RMB / Shift+LMB remove
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
