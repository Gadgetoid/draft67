// Voxel store + per-material InstancedMesh rendering.
// Blocks are unit cubes centred on integer coords; the hatch shader samples world position,
// so neighbouring blocks of the same material merge into one continuous drawn surface.
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, uniform, vec2, vec3, positionWorld, fract, min, max, abs, dFdx, dFdy, length, smoothstep, float } from 'three/tsl';
import { MATERIALS, makeHatchTexture, makeBayerTexture } from './materials.js';
import { makeHatchMaterial } from './hatchMaterial.js';

const GROUND_SIZE = 400;

const CUBE = new THREE.BoxGeometry(1, 1, 1);
const key = (x, y, z) => `${x},${y},${z}`;

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
    groundMat.colorNode = vec3(0.078, 0.067, 0.043);
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
      const entry = { mesh: null, coords: [], mat, idMaterial, materialId: m.id };
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

  set(x, y, z, materialId) {
    this.voxels.set(key(x, y, z), materialId);
    this._rebuild();
  }
  remove(x, y, z) {
    if (this.voxels.delete(key(x, y, z))) this._rebuild();
  }
  clear() { this.voxels.clear(); this._rebuild(); }

  // rebuild every per-material instanced mesh from the voxel map
  _rebuild() {
    for (const entry of this.meshes.values()) entry.coords.length = 0;
    for (const [k, mid] of this.voxels) {
      const entry = this.meshes.get(mid) || this.meshes.get(MATERIALS[0].id);
      const [x, y, z] = k.split(',').map(Number);
      entry.coords.push(x, y, z);
    }
    const mat4 = new THREE.Matrix4();
    for (const entry of this.meshes.values()) {
      const coords = entry.coords;
      const need = coords.length / 3;
      let mesh = entry.mesh;
      // Grow by RECREATING the InstancedMesh (fresh GPU buffers). Swapping the instanceMatrix
      // attribute in place leaves WebGPU bound to the stale buffer, so live edits stop showing.
      if (need > mesh.instanceMatrix.count) {
        this.group.remove(mesh);
        mesh.dispose();
        let cap = 16; while (cap < need) cap *= 2;
        mesh = entry.mesh = this._makeMesh(entry, cap);
      }
      for (let i = 0; i < need; i++) {
        mat4.makeTranslation(coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]);
        mesh.setMatrixAt(i, mat4);
      }
      mesh.count = need;
      mesh.instanceMatrix.needsUpdate = true;
      // Invalidate the instanced broad-phase bounds so raycasting sees the new instances.
      mesh.boundingSphere = null;
      mesh.boundingBox = null;
      mesh.computeBoundingSphere();
    }
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
      const i = h.instanceId * 3;
      const c = [entry.coords[i], entry.coords[i + 1], entry.coords[i + 2]];
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
    this.voxels.clear();
    for (const b of arr) this.voxels.set(key(b.x, b.y, b.z), b.m);
    this._rebuild();
  }
}
