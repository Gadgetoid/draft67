// Chamfer-target highlights: thin ink bars (theme-coloured) laid along targeted edges/corners,
// plus a faint ghost of the full unit cube showing the original bounds being chamfered.
// One hover bar follows the pointer; a pool of bars marks the multi-selection. Everything is
// screen-space Bayer-stippled (matching the hatch shading) so the geometry beneath stays
// readable and the output remains strictly two-tone. All meshes skip the outline passes.
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { texture, screenCoordinate, fract, step, float } from 'three/tsl';
import { makeBayerTexture } from './materials.js';
import { inkColor } from './theme.js';
import { elementOffset } from './chamfer.js';

const BAR = 0.07;          // edge bar thickness
const CORNER = 0.16;       // corner marker size
const PROUD = 1.02;        // slightly proud of the block so it doesn't z-fight coplanar faces
const EMPHASIS = 1.8;      // thickness multiplier while a drag is active (press affirmation)
const BAR_COVER = 0.5;     // stipple coverage of the target bars
const GHOST_COVER = 0.25;  // stipple coverage of the ghost cube

// Adds the highlight meshes to the scene and returns { hover, select }.
// hover(coord, elementId, active): bar + ghost under the pointer; hover(null) hides.
// select(items, active): persistent bars for [{ coord, element }] selections.
// Both return true if the visible state actually changed.
export function createHighlight(scene) {
  const bayer = makeBayerTexture();
  // ordered-dither mask: keep a pixel where the Bayer threshold sits under the coverage
  const stipple = (coverage) => step(texture(bayer, fract(screenCoordinate.xy.div(8.0))).r, float(coverage));

  const barMat = new MeshBasicNodeMaterial();
  barMat.colorNode = inkColor;
  barMat.opacityNode = stipple(BAR_COVER);
  barMat.alphaTest = 0.5;
  barMat.depthTest = false;
  barMat.depthWrite = false;

  const geo = new THREE.BoxGeometry(1, 1, 1);
  function makeBar() {
    const bar = new THREE.Mesh(geo, barMat);
    bar.visible = false;
    bar.renderOrder = 3;
    bar.userData.excludeFromOutline = true;
    scene.add(bar);
    return bar;
  }
  const hoverBar = makeBar();
  const pool = [];

  const ghostMat = new MeshBasicNodeMaterial();
  ghostMat.colorNode = inkColor;
  ghostMat.opacityNode = stipple(GHOST_COVER);
  ghostMat.alphaTest = 0.5;
  ghostMat.depthWrite = false;
  const ghost = new THREE.Mesh(geo, ghostMat);
  ghost.scale.setScalar(PROUD);
  ghost.visible = false;
  ghost.renderOrder = 2; // after the world, so depthWrite:false can't be painted over
  ghost.userData.excludeFromOutline = true;
  scene.add(ghost);

  function layout(bar, coord, elementId, active) {
    const { offset, freeAxis } = elementOffset(elementId);
    bar.position.set(coord[0] + offset[0], coord[1] + offset[1], coord[2] + offset[2]);
    const t = active ? EMPHASIS : 1;
    if (freeAxis === null) bar.scale.setScalar(CORNER * t);
    else { bar.scale.setScalar(BAR * t); bar.scale.setComponent(freeAxis, PROUD); }
  }

  let hoverKey = null;
  function hover(coord, elementId, active = false) {
    const next = coord && elementId ? `${coord.join(',')}|${elementId}|${active ? 1 : 0}` : null;
    if (next === hoverKey) return false;
    hoverKey = next;
    if (!next) {
      hoverBar.visible = false;
      ghost.visible = false;
      return true;
    }
    ghost.position.set(coord[0], coord[1], coord[2]);
    ghost.visible = true;
    layout(hoverBar, coord, elementId, active);
    hoverBar.visible = true;
    return true;
  }

  // Build-mode placement preview: a stippled ghost of the block about to be placed.
  const placeGhost = new THREE.Mesh(geo, ghostMat);
  placeGhost.scale.setScalar(PROUD);
  placeGhost.visible = false;
  placeGhost.renderOrder = 2;
  placeGhost.userData.excludeFromOutline = true;
  scene.add(placeGhost);

  let placeKey = null;
  function place(coord) {
    const next = coord ? coord.join(',') : null;
    if (next === placeKey) return false;
    placeKey = next;
    if (!coord) { placeGhost.visible = false; return true; }
    placeGhost.position.set(coord[0], coord[1], coord[2]);
    placeGhost.visible = true;
    return true;
  }

  let selectionKey = '';
  function select(items, active = false) {
    const key = items.map((s) => `${s.coord.join(',')}|${s.element}`).join(';') + (active ? '!' : '');
    if (key === selectionKey) return false;
    selectionKey = key;
    while (pool.length < items.length) pool.push(makeBar());
    items.forEach((s, i) => { layout(pool[i], s.coord, s.element, active); pool[i].visible = true; });
    for (let i = items.length; i < pool.length; i++) pool[i].visible = false;
    return true;
  }

  return { hover, select, place };
}
