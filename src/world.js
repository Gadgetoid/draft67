// Voxel store + per-material InstancedMesh rendering.
// Blocks are unit cubes centred on integer coords; the hatch shader samples world position,
// so neighbouring blocks of the same material merge into one continuous drawn surface.
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, uniform, vec2, positionWorld, fract, min, max, abs, dFdx, dFdy, length, smoothstep, float } from 'three/tsl';
import { MATERIALS, makeHatchTexture, makeBayerTexture } from './materials.js';
import { makeHatchMaterial } from './hatchMaterial.js';
import { inkColor } from './theme.js';

const GROUND_SIZE = 400;

const CUBE = new THREE.BoxGeometry(1, 1, 1);
const key = (x, y, z) => `${x},${y},${z}`;
const CUBE_R = Math.sqrt(3) / 2; // half-diagonal of a unit cube (for broad-phase bounds)
const _m4 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _sphere = new THREE.Sphere();

export class VoxelWorld {
  constructor(scene) {
    this.scene = scene;
    this.voxels = new Map(); // "x,y,z" -> materialId
    this.group = new THREE.Group();
    scene.add(this.group);

    // Build plane at y=-0.5 (top of the y=0 block layer). Procedural single-line grid, aligned
    // to block edges, that fades out with distance. Always present so the ray can always hit it.
    this.gridCenter = uniform(vec2(0, 0)); // follows the camera focus so the grid stays under the work
    const gridCenter = this.gridCenter;
    const groundMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    groundMat.colorNode = inkColor;
    groundMat.opacityNode = Fn(() => {
      const pw = positionWorld.xz.add(0.5);             // block edges land on integer cells
      const g = fract(pw);
      const d = min(g, vec2(1, 1).sub(g));              // per-axis distance to nearest line
      // FIXED thin lines with a soft (pixel-sized) AA edge, so distant cells stay thin lines
      // rather than filling into a grey wash.
      const w = float(0.006);                           // line half-width (world units)
      const aa = abs(dFdx(pw)).add(abs(dFdy(pw))).mul(0.75).add(0.0015);
      const lx = float(1).sub(smoothstep(w, w.add(aa.x), d.x));
      const lz = float(1).sub(smoothstep(w, w.add(aa.y), d.y));
      const line = max(lx, lz);
      // fade out around the camera focus so the grid always sits under the work, never a grey field
      const dist = length(positionWorld.xz.sub(gridCenter));
      const falloff = float(1).sub(smoothstep(9.0, 20.0, dist));
      return line.mul(0.2).mul(falloff);
    })();
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.5;
    this.ground.renderOrder = -1;
    this.ground.userData.excludeFromOutline = true; // reference grid: never ink-outline it
    scene.add(this.ground);

    const bayer = makeBayerTexture();
    this.meshes = new Map(); // materialId -> { mesh, coords, mat, idMaterial, materialId }
    MATERIALS.forEach((m, idx) => {
      const tex = makeHatchTexture(m);
      // rectilinear materials stay axis-aligned so courses wrap cleanly; metals rotate per axis
      const mat = makeHatchMaterial(tex, bayer, { scale: 0.5, rot: m.align ? [0, 0, 0] : undefined });
      const idVal = (idx + 1) / (MATERIALS.length + 1);
      const idMaterial = new MeshBasicNodeMaterial({ color: new THREE.Color(idVal, idVal, idVal) });
      const entry = {
        mesh: null, mat, idMaterial, materialId: m.id,
        keyToIndex: new Map(), // voxel key -> instance index
        indexToKey: [],        // instance index -> voxel key
      };
      entry.mesh = this._makeMesh(entry, 16);
      this.meshes.set(m.id, entry);
    });
  }

  _makeMesh(entry, capacity) {
    const mesh = new THREE.InstancedMesh(CUBE, entry.mat, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.materialId = entry.materialId;
    mesh.userData.idMaterial = entry.idMaterial;
    this.group.add(mesh);
    return mesh;
  }

  setGridCenter(x, z) { this.gridCenter.value.set(x, z); }

  has(x, y, z) { return this.voxels.has(key(x, y, z)); }
  get size() { return this.voxels.size; }

  // Incremental edits: O(1) per block (append / swap-remove), not a full per-material rebuild.
  set(x, y, z, materialId) {
    const k = key(x, y, z);
    const existing = this.voxels.get(k);
    if (existing === materialId) return;
    if (existing !== undefined) this._removeInstance(existing, k);
    this.voxels.set(k, materialId);
    this._addInstance(materialId, k, x, y, z);
  }

  remove(x, y, z) {
    const k = key(x, y, z);
    const mid = this.voxels.get(k);
    if (mid === undefined) return;
    this.voxels.delete(k);
    this._removeInstance(mid, k);
  }

  clear() {
    this.voxels.clear();
    for (const e of this.meshes.values()) {
      e.mesh.count = 0;
      e.mesh.instanceMatrix.needsUpdate = true;
      e.mesh.boundingSphere = null;
      e.keyToIndex.clear();
      e.indexToKey.length = 0;
    }
  }

  _addInstance(materialId, k, x, y, z) {
    const e = this.meshes.get(materialId) || this.meshes.get(MATERIALS[0].id);
    let mesh = e.mesh;
    const i = mesh.count;
    if (i >= mesh.instanceMatrix.count) mesh = this._growEntry(e);
    mesh.setMatrixAt(i, _m4.makeTranslation(x, y, z));
    mesh.count = i + 1;
    mesh.instanceMatrix.needsUpdate = true;
    e.keyToIndex.set(k, i);
    e.indexToKey[i] = k;
    // grow the broad-phase bounds to include the new block (never shrink -> stays valid for picks)
    _sphere.set(_v.set(x, y, z), CUBE_R);
    if (mesh.boundingSphere) mesh.boundingSphere.union(_sphere);
    else mesh.boundingSphere = _sphere.clone();
  }

  _removeInstance(materialId, k) {
    const e = this.meshes.get(materialId);
    if (!e) return;
    const mesh = e.mesh;
    const i = e.keyToIndex.get(k);
    if (i === undefined) return;
    const last = mesh.count - 1;
    if (i !== last) { // swap the last instance into the freed slot
      mesh.getMatrixAt(last, _m4);
      mesh.setMatrixAt(i, _m4);
      const movedKey = e.indexToKey[last];
      e.keyToIndex.set(movedKey, i);
      e.indexToKey[i] = movedKey;
    }
    mesh.count = last;
    mesh.instanceMatrix.needsUpdate = true;
    e.keyToIndex.delete(k);
    e.indexToKey.length = last;
    // bounding sphere intentionally left as-is: still encloses all remaining instances
  }

  // Grow by RECREATING the InstancedMesh (fresh GPU buffers) and copying existing instances.
  // Swapping the instanceMatrix attribute in place leaves WebGPU bound to a stale buffer.
  _growEntry(e) {
    const old = e.mesh;
    const cap = Math.max(16, old.instanceMatrix.count * 2);
    const mesh = this._makeMesh(e, cap);
    for (let i = 0; i < old.count; i++) { old.getMatrixAt(i, _m4); mesh.setMatrixAt(i, _m4); }
    mesh.count = old.count;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.boundingSphere = old.boundingSphere ? old.boundingSphere.clone() : null;
    this.group.remove(old);
    old.dispose();
    e.mesh = mesh;
    return mesh;
  }

  // Ray pick -> { place:[x,y,z], remove:[x,y,z]|null } or null.
  // Nearest hit wins: a block face places on the neighbouring cell (and can be removed);
  // the ground plane places on that grid cell at y=0 (and cannot be removed).
  pick(raycaster) {
    const targets = [...this.meshes.values()].map((e) => e.mesh);
    targets.push(this.ground);
    const hits = raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      if (h.object === this.ground) {
        return { place: [Math.round(h.point.x), 0, Math.round(h.point.z)], remove: null };
      }
      if (h.instanceId == null) continue;
      const entry = this.meshes.get(h.object.userData.materialId);
      const k = entry.indexToKey[h.instanceId];
      if (k === undefined) continue;
      const c = k.split(',').map(Number);
      const n = h.face.normal; // local == world (axis-aligned, translation-only)
      const normal = [Math.round(n.x), Math.round(n.y), Math.round(n.z)];
      return { place: [c[0] + normal[0], c[1] + normal[1], c[2] + normal[2]], remove: c };
    }
    return null;
  }

  toJSON() {
    return [...this.voxels].map(([k, mid]) => {
      const [x, y, z] = k.split(',').map(Number);
      return { x, y, z, m: mid };
    });
  }
  fromJSON(arr) {
    if (!Array.isArray(arr)) throw new Error('invalid model: expected an array');
    this.clear();
    for (const b of arr) {
      if (typeof b?.x !== 'number' || typeof b?.y !== 'number' || typeof b?.z !== 'number') {
        throw new Error('invalid model: bad block entry');
      }
      this.set(b.x, b.y, b.z, b.m);
    }
  }
}
