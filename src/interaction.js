// Raycast add/remove of blocks, in both orbit (mouse) and first-person (crosshair) modes.
// Chamfer editing is press-and-drag: pressing an edge/corner affirms the target (emphasized
// highlight), dragging toward the block centre deepens the cut in snapped steps with live
// geometry, and releasing without a drag changes nothing. Shift+Click toggles elements into a
// multi-selection that drags together; each element clamps at the extremes, so overshooting
// equalizes unaligned cuts (drag all to zero, then back in to a common depth).
import * as THREE from 'three';
import { nearestElement, elementOffset, AMOUNTS } from './chamfer.js';

const STEP_PX = 30; // drag distance per amount step

export function attachInteraction({ dom, world, rig, ui, onChange, getBrush = () => 'add', getChamfer = () => false, onHover = () => {}, onSelection = () => {} }) {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const _pe = new THREE.Vector3(), _pc = new THREE.Vector3();
  let downX = 0, downY = 0, downId = null, active = 0, maxActive = 0;
  let hover = null;            // last hovered chamfer target { coord, element }
  const selection = new Map(); // "x,y,z|element" -> { coord, element }
  let cham = null;             // active chamfer drag { items, dx, dy, lx, ly, orbit, anchor }

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

  // Ray entry distance into the FULL unit cube at coord (0 if the eye is inside), or null.
  function cubeEntry(coord) {
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
    return tnear >= 0 ? tnear : 0;
  }

  // The element a chamfer hit targets. We ray-test the FULL cube (ghost bounds) at this block as a
  // proxy, so every original edge/corner stays selectable no matter how the block is already carved
  // (e.g. a fully-sliced edge, or the corners at the ends of a bevelled edge).
  function targetElement(coord) {
    const t = cubeEntry(coord);
    if (t === null) return null;
    const r = ray.ray, O = r.origin, D = r.direction;
    return nearestElement({ x: O.x + D.x * t - coord[0], y: O.y + D.y * t - coord[1], z: O.z + D.z * t - coord[2] });
  }

  // Chamfer targeting: walk the voxel grid along the ray (DDA) and take the FIRST existing block
  // whose FULL cube the ray crosses, stopping at the picked surface. Carved-away regions still
  // belong to their block, so cut edges/corners stay targetable, and a graze through one block's
  // cut can never select whatever lies behind it.
  function chamferTarget() {
    const hit = world.pick(ray);
    const tmax = (hit ? hit.dist : 60) + 1e-4;
    const O = ray.ray.origin, D = ray.ray.direction;
    let cx = Math.round(O.x), cy = Math.round(O.y), cz = Math.round(O.z);
    const sx = Math.sign(D.x), sy = Math.sign(D.y), sz = Math.sign(D.z);
    const dtx = 1 / Math.abs(D.x), dty = 1 / Math.abs(D.y), dtz = 1 / Math.abs(D.z);
    let tx = sx ? (cx + 0.5 * sx - O.x) / D.x : Infinity;
    let ty = sy ? (cy + 0.5 * sy - O.y) / D.y : Infinity;
    let tz = sz ? (cz + 0.5 * sz - O.z) / D.z : Infinity;
    for (let i = 0, t = 0; i < 400 && t <= tmax; i++) {
      if (world.has(cx, cy, cz)) {
        const element = targetElement([cx, cy, cz]);
        return element ? { coord: [cx, cy, cz], element } : null;
      }
      if (tx <= ty && tx <= tz) { t = tx; tx += dtx; cx += sx; }
      else if (ty <= tz) { t = ty; ty += dty; cy += sy; }
      else { t = tz; tz += dtz; cz += sz; }
    }
    return null;
  }

  // --- chamfer drag ------------------------------------------------------------------------------

  const selKey = (coord, element) => `${coord.join(',')}|${element}`;

  function snapAmount(v) {
    let best = 0, bd = Infinity;
    for (const a of AMOUNTS) { const d = Math.abs(a - v); if (d < bd) { bd = d; best = a; } }
    return best;
  }

  function syncSelection(dragging = false) {
    for (const [k, s] of selection) if (!world.has(...s.coord)) selection.delete(k);
    onSelection([...selection.values()], dragging);
  }
  function clearSelection() {
    if (!selection.size) return;
    selection.clear();
    onSelection([], false);
  }

  // screen-space direction that deepens the cut: from the element toward its block centre
  function deepenDir(coord, element) {
    const r = dom.getBoundingClientRect();
    const { offset } = elementOffset(element);
    _pe.set(coord[0] + offset[0], coord[1] + offset[1], coord[2] + offset[2]).project(rig.activeCamera);
    _pc.set(coord[0], coord[1], coord[2]).project(rig.activeCamera);
    const dx = (_pc.x - _pe.x) * r.width, dy = -(_pc.y - _pe.y) * r.height;
    const len = Math.hypot(dx, dy);
    return len < 1e-6 ? { dx: 0, dy: 1 } : { dx: dx / len, dy: dy / len };
  }

  // the chamfer target under the pointer: the current hover for mouse, a fresh cast for touch
  function resolveTarget(e) {
    castFromMouse(e);
    if (e.pointerType !== 'touch' && hover) return hover;
    return chamferTarget();
  }

  function chamStart(e, items, anchor) {
    const list = items.map(({ coord, element }) => {
      const val = snapAmount(world.getCuts(...coord).get(element) || 0);
      return { coord, element, val, applied: val };
    });
    cham = { items: list, ...deepenDir(anchor.coord, anchor.element), lx: e.clientX, ly: e.clientY, orbit: rig.orbit.enabled, anchor };
    rig.orbit.enabled = false; // this gesture owns the pointer
    try { dom.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    onHover(anchor.coord, anchor.element, true);
    if (selection.size) syncSelection(true);
  }

  function chamDrag(e) {
    const step = (((e.clientX - cham.lx) * cham.dx + (e.clientY - cham.ly) * cham.dy) / STEP_PX) * 0.2;
    cham.lx = e.clientX; cham.ly = e.clientY;
    let changed = false;
    for (const it of cham.items) {
      // per-element accumulator, clamped: overshoot is absorbed, so a multi-drag equalizes at 0/1
      it.val = Math.min(1, Math.max(0, it.val + step));
      let amt = snapAmount(it.val);
      // block budget: step down until the block's cut total fits
      const cm = world.getCuts(...it.coord);
      const cur = cm.get(it.element) || 0;
      let total = 0; for (const v of cm.values()) total += v;
      const room = (world.chamferBudget ?? Infinity) - (total - cur);
      while (amt > 0 && amt > room + 1e-9) amt = AMOUNTS[AMOUNTS.indexOf(amt) - 1];
      if (amt < snapAmount(it.val)) it.val = amt; // budget-limited: don't bank unreachable travel
      if (amt !== it.applied) {
        it.applied = amt;
        world.setCut(it.coord[0], it.coord[1], it.coord[2], it.element, amt);
        changed = true;
      }
    }
    if (changed) onChange?.();
  }

  function chamEnd() {
    if (!cham) return;
    if (rig.mode === 'orbit' && !rig.blueprint) rig.orbit.enabled = cham.orbit;
    onHover(cham.anchor.coord, cham.anchor.element, false);
    if (selection.size) syncSelection(false);
    cham = null;
  }

  // returns true if a block was actually placed/removed
  function edit(remove) {
    if (rig.blueprint) return false; // no editing in blueprint preview
    const hit = world.pick(ray);
    if (!hit) return false;
    if (remove) {
      if (hit.remove) {
        world.remove(...hit.remove);
        onChange?.();
        if (selection.size) syncSelection();
        return true;
      }
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
    if (cham) { if (active > 1) chamEnd(); return; } // second finger: yield to pinch/pan
    if (active !== 1 || rig.mode !== 'orbit' || rig.blueprint || !getChamfer()) return;
    if (e.pointerType !== 'touch' && e.button !== 0) return;
    const t = resolveTarget(e);
    if (!t) return; // empty space: leave the pointer to the camera
    if (e.shiftKey) {
      const k = selKey(t.coord, t.element);
      if (selection.has(k)) selection.delete(k); else selection.set(k, t);
      syncSelection();
      return;
    }
    if (selection.has(selKey(t.coord, t.element))) {
      chamStart(e, [...selection.values()], t); // drag the whole selection from any member
    } else {
      clearSelection();
      chamStart(e, [t], t);
    }
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
  dom.addEventListener('pointercancel', (e) => { endPointer(e); chamEnd(); });
  // chamfer-mode hover: highlight the edge/corner under the cursor (skip while a pointer is down)
  dom.addEventListener('pointermove', (e) => {
    if (cham) { chamDrag(e); return; }
    if (rig.mode !== 'orbit' || rig.blueprint || active > 0 || !getChamfer()) { onHover(null); return; }
    castFromMouse(e);
    const t = chamferTarget();
    hover = t;
    if (t) onHover(t.coord, t.element);
    else onHover(null);
  });
  dom.addEventListener('pointerup', (e) => {
    const { primary, multi, dist } = endPointer(e);
    if (cham) { if (primary) chamEnd(); return; }
    if (rig.mode !== 'orbit') return;
    if (!primary || multi || dist > 7) return;       // multi-touch gesture or a drag, not a tap
    if (e.pointerType !== 'touch' && e.button !== 0 && e.button !== 2) return; // desktop L/R only
    castFromMouse(e);
    if (getChamfer()) {
      // cut changes happen via press-and-drag; a tap on empty space just deselects
      const hit = world.pick(ray);
      if ((!hit || !hit.coord) && !e.shiftKey) clearSelection();
      return;
    }
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

  return {
    clearSelection,
    // debug handles (used by the headless verifier)
    getSelection: () => [...selection.keys()],
    getHover: () => (hover ? selKey(hover.coord, hover.element) : null),
  };
}
