// Chamfer-target highlight: a thin ink bar (theme-coloured) laid along the targeted edge or
// corner, plus a faint translucent ghost of the full unit cube showing the original bounds
// being chamfered. Both are excluded from the outline passes.
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { inkColor } from './theme.js';
import { elementOffset } from './chamfer.js';

const BAR = 0.07;     // edge bar thickness
const CORNER = 0.16;  // corner marker size
const PROUD = 1.02;   // slightly proud of the block so it doesn't z-fight coplanar faces

// Adds the highlight meshes to the scene and returns show(coord, elementId).
// show(null) hides. Returns true if the visible state actually changed.
export function createHighlight(scene) {
  const barMat = new MeshBasicNodeMaterial();
  barMat.colorNode = inkColor;
  barMat.depthTest = false;
  barMat.depthWrite = false;
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), barMat);
  bar.visible = false;
  bar.renderOrder = 3;
  bar.userData.excludeFromOutline = true;
  scene.add(bar);

  const ghostMat = new MeshBasicNodeMaterial();
  ghostMat.colorNode = inkColor;
  ghostMat.transparent = true;
  ghostMat.opacity = 0.16;
  ghostMat.depthWrite = false;
  const ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), ghostMat);
  ghost.scale.setScalar(PROUD);
  ghost.visible = false;
  ghost.userData.excludeFromOutline = true;
  scene.add(ghost);

  let shown = null; // "x,y,z|elementId" currently displayed

  return function show(coord, elementId) {
    const next = coord && elementId ? `${coord.join(',')}|${elementId}` : null;
    if (next === shown) return false;
    shown = next;
    if (!next) {
      bar.visible = false;
      ghost.visible = false;
      return true;
    }
    ghost.position.set(coord[0], coord[1], coord[2]);
    ghost.visible = true;
    const { offset, freeAxis } = elementOffset(elementId);
    bar.position.set(coord[0] + offset[0], coord[1] + offset[1], coord[2] + offset[2]);
    if (freeAxis === null) bar.scale.setScalar(CORNER);
    else { bar.scale.setScalar(BAR); bar.scale.setComponent(freeAxis, PROUD); }
    bar.visible = true;
    return true;
  };
}
