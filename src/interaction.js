// Raycast add/remove of blocks, in both orbit (mouse) and first-person (crosshair) modes.
// Chamfer editing is press-and-drag: pressing an edge/corner affirms the target (emphasized
// highlight), dragging toward the block centre deepens the cut in snapped steps with live
// geometry, and releasing without a drag changes nothing. Shift+Click toggles elements into a
// multi-selection that drags together; each element clamps at the extremes, so overshooting
// equalizes unaligned cuts (drag all to zero, then back in to a common depth).
import * as THREE from 'three';
import { nearestElement, elementOffset, chamferVolume, AMOUNTS } from './chamfer.js';

const STEP_PX = 30;      // drag distance per amount step
const MIN_VOLUME = 0.03; // reject a cut that would carve the block below this (of a unit cube)

export function attachInteraction({ dom, world, rig, ui, onChange, getBrush = () => 'add', getChamfer = () => false, getPaint = () => false, onHover = () => {}, onSelection = () => {}, onPlace = () => {} }) {
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

  // A block's cut map with one element proposed at `amt` (deleted at 0), for testing the result.
  function proposedCuts(coord, element, amt) {
    const cm = new Map(world.getCuts(...coord));
    if (amt > 0) cm.set(element, amt); else cm.delete(element);
    return cm;
  }

  // Advance one chamfer element by `step`: accumulate (clamped 0..1 so overshoot equalizes a
  // multi-drag), snap, then back off any step that would carve the block out of existence.
  function applyStep(it, step) {
    it.val = Math.min(1, Math.max(0, it.val + step));
    let amt = snapAmount(it.val);
    while (amt > 0 && chamferVolume(proposedCuts(it.coord, it.element, amt)) < MIN_VOLUME) {
      amt = AMOUNTS[AMOUNTS.indexOf(amt) - 1];
    }
    if (amt < snapAmount(it.val)) it.val = amt; // don't bank travel we couldn't apply
    if (amt === it.applied) return false;
    it.applied = amt;
    world.setCut(it.coord[0], it.coord[1], it.coord[2], it.element, amt);
    return true;
  }

  function chamDrag(e) {
    const step = (((e.clientX - cham.lx) * cham.dx + (e.clientY - cham.ly) * cham.dy) / STEP_PX) * 0.2;
    cham.lx = e.clientX; cham.ly = e.clientY;
    let changed = false;
    for (const it of cham.items) changed = applyStep(it, step) || changed;
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

  // Paint: reswatch the targeted block to the selected material (keeps its shape).
  function paint() {
    if (rig.blueprint) return false;
    const hit = world.pick(ray);
    if (!hit || !hit.remove) return false;
    const c = hit.remove;
    if (world.material(...c) === ui.material) return false;
    world.set(c[0], c[1], c[2], ui.material);
    onChange?.();
    return true;
  }

  // Ghost preview of the target under the pointer in build (empty cell) and paint
  // (existing block) modes. Returns null in chamfer mode or over empty space.
  function previewCoord() {
    const hit = world.pick(ray);
    if (!hit) return null;
    if (getPaint()) return hit.remove || null;
    return hit.place && !world.has(...hit.place) ? hit.place : null;
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
  // Hover preview (skip while a pointer is down): chamfer edge/corner bars, or a
  // ghost cube at the build/paint target.
  dom.addEventListener('pointermove', (e) => {
    if (cham) { chamDrag(e); return; }
    if (rig.mode === 'fp') return;                                  // first-person aim owned by updateAim()
    if (rig.blueprint || active > 0) { onHover(null); onPlace(null); return; }
    castFromMouse(e);
    if (getChamfer()) {
      const t = chamferTarget();
      hover = t;
      onHover(t ? t.coord : null, t ? t.element : null);
      onPlace(null);
    } else {
      onHover(null);
      onPlace(previewCoord());
    }
  });
  dom.addEventListener('pointerleave', () => { onHover(null); onPlace(null); });
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
    if (getPaint() && e.button !== 2) { paint(); return; } // Paint tool: L/tap reswatches
    if (e.pointerType === 'touch') edit(getBrush() === 'del'); // mobile: Add/Del brush
    else edit(e.button === 2 || e.shiftKey);           // desktop: LMB place, RMB / Shift+LMB remove
  });
  dom.addEventListener('contextmenu', (e) => e.preventDefault());

  // First-person mode: pointer-locked, act from the crosshair (ray through the screen centre).
  // Build / paint / erase run as a held stroke - sweep the crosshair to keep going. Chamfer applies
  // one snapped step per click (a drag is reserved for looking around); Shift or RMB steps back out.
  // Building is cell-relative: a block lands whenever the crosshair moves onto a new empty cell, and
  // cells laid during THIS stroke are ignored as targets so you don't build a stack at your face.
  let stroke = null;           // { kind: 'build' | 'erase' | 'paint' } while a button is held
  let fpCham = null;           // { anchor, item, dx, dy } while chamfering by hold-and-look
  let lastErase = 0, aiming = false;
  const strokePlaced = new Set();
  const ERASE_MS = 140;        // min gap between erases so a sweep doesn't blow away a whole row at once

  function strokeTick() {
    castFromCenter();
    const hit = world.pick(ray);
    if (!hit) return;
    if (stroke.kind === 'erase') {
      const now = performance.now();
      if (hit.remove && now - lastErase >= ERASE_MS) { world.remove(...hit.remove); lastErase = now; onChange?.(); }
    } else if (stroke.kind === 'paint') {
      if (hit.remove && world.material(...hit.remove) !== ui.material) { world.set(...hit.remove, ui.material); onChange?.(); }
    } else {
      if (hit.remove && strokePlaced.has(hit.remove.join(','))) return;
      if (world.has(...hit.place)) return;
      world.set(...hit.place, ui.material); strokePlaced.add(hit.place.join(',')); onChange?.();
    }
  }
  // While holding, run every frame so arrow-key look (not just the mouse) keeps the stroke going.
  function strokeLoop() {
    if (!stroke) return;
    if (rig.mode === 'fp' && rig.fp.isLocked) strokeTick();
    requestAnimationFrame(strokeLoop);
  }

  // Chamfer by hold-and-look: pressing anchors the crosshair's edge/corner; mouse motion then feeds
  // the same pointer-locked deltas that turn the view into the cut depth (toward the block deepens,
  // back out reduces), so you keep looking around while adjusting - the orbit drag, hands-free.
  function fpChamStart() {
    const t = chamferTarget();          // ray already cast from the centre
    if (!t) return;
    const val = snapAmount(world.getCuts(...t.coord).get(t.element) || 0);
    fpCham = { anchor: t, item: { coord: t.coord, element: t.element, val, applied: val }, ...deepenDir(t.coord, t.element) };
    onHover(t.coord, t.element, true);  // emphasized while adjusting
  }
  function fpChamDrag(e) {
    const step = ((e.movementX * fpCham.dx + e.movementY * fpCham.dy) / STEP_PX) * 0.2;
    if (applyStep(fpCham.item, step)) onChange?.();
  }
  function fpChamEnd() {
    if (!fpCham) return;
    onHover(fpCham.anchor.coord, fpCham.anchor.element, false);
    fpCham = null;
  }

  dom.addEventListener('click', () => { if (rig.mode === 'fp' && !rig.fp.isLocked) rig.fp.lock(); });
  dom.addEventListener('mousedown', (e) => {
    if (rig.mode !== 'fp' || !rig.fp.isLocked) return;
    if (e.button !== 0 && e.button !== 2) return; // ignore middle etc.
    castFromCenter();
    if (getChamfer()) { fpChamStart(); return; }  // hold, then look to adjust the cut
    stroke = { kind: (e.button === 2 || e.shiftKey) ? 'erase' : getPaint() ? 'paint' : 'build' };
    strokePlaced.clear();
    strokeTick();
    requestAnimationFrame(strokeLoop);
  });
  // Pointer-locked look deltas (same motion that rotates the view) drive an in-progress chamfer.
  document.addEventListener('mousemove', (e) => { if (fpCham) fpChamDrag(e); });
  addEventListener('mouseup', () => { stroke = null; fpChamEnd(); });

  // Crosshair aim feedback, called each frame from the render loop while flying: chamfer bars on
  // the targeted edge/corner, or the build/paint ghost at whatever the centre ray hits.
  function updateAim() {
    const active = rig.mode === 'fp' && rig.fp.isLocked && !rig.blueprint && !stroke && !fpCham;
    if (!active) { if (aiming) { onHover(null); onPlace(null); aiming = false; } return; }
    aiming = true;
    castFromCenter();
    if (getChamfer()) { const t = chamferTarget(); onHover(t ? t.coord : null, t ? t.element : null); onPlace(null); }
    else { onHover(null); onPlace(previewCoord()); }
  }

  return {
    clearSelection,
    updateAim,
    // debug handles (used by the headless verifier)
    getSelection: () => [...selection.keys()],
    getHover: () => (hover ? selKey(hover.coord, hover.element) : null),
  };
}
