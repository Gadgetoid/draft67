// Chamfered blocks as convex polytopes: a unit cube intersected with a set of cut planes.
// An EDGE bevel is a 45-degree plane; a CORNER cut is a diagonal plane. Because a convex solid
// clipped by half-spaces is always convex, ANY combination of edge/corner cuts composes cleanly.
// Element ids: edges "e|<axis-pair>|<signs>" (e.g. "e|xy|+-"), corners "c|<signs>" (e.g. "c|+-+").
import * as THREE from 'three';

const AX = ['x', 'y', 'z'];
// Cut amount is the fraction from the element (edge/vertex) to the block CENTRE:
//   0 = no cut · 0.5 = classic 45-degree chamfer (to the face mid-lines) · 1 = a full diagonal
//   slice through the middle (right-triangle wedge / slope, for rooflines etc).
export const AMOUNTS = [0, 0.2, 0.4, 0.6, 0.8, 1];

// step a cut amount to the next (dir=+1) or previous (dir=-1) value, wrapping around
export function cycleAmount(a, dir = 1) {
  let i = 0, best = Infinity;
  AMOUNTS.forEach((v, k) => { const d = Math.abs(v - (a || 0)); if (d < best) { best = d; i = k; } });
  const n = AMOUNTS.length;
  return AMOUNTS[((i + dir) % n + n) % n];
}

// offset of an element's centre from its block centre; freeAxis is the axis an edge runs
// along (0/1/2), or null for a corner
export function elementOffset(id) {
  const parts = id.split('|');
  const offset = [0, 0, 0];
  if (parts[0] === 'c') {
    for (let i = 0; i < 3; i++) offset[i] = parts[1][i] === '+' ? 0.5 : -0.5;
    return { offset, freeAxis: null };
  }
  const a0 = AX.indexOf(parts[1][0]), a1 = AX.indexOf(parts[1][1]);
  offset[a0] = parts[2][0] === '+' ? 0.5 : -0.5;
  offset[a1] = parts[2][1] === '+' ? 0.5 : -0.5;
  return { offset, freeAxis: 3 - a0 - a1 };
}

// the cutting plane {n (unit), d} for an element at cut depth a; interior is n·p <= d
export function elementPlane(id, a) {
  const parts = id.split('|');
  if (parts[0] === 'c') {
    const s = parts[1].split('').map((c) => (c === '+' ? 1 : -1));
    return { n: new THREE.Vector3(s[0], s[1], s[2]).normalize(), d: (Math.sqrt(3) / 2) * (1 - a) };
  }
  const pair = parts[1], signs = parts[2];
  const n = new THREE.Vector3();
  n[pair[0]] = signs[0] === '+' ? 1 : -1;
  n[pair[1]] = signs[1] === '+' ? 1 : -1;
  n.normalize();
  return { n, d: (1 - a) / Math.SQRT2 };
}

// nearest edge/corner element to a local hit point (each coord in [-0.5, 0.5]).
// gap[i] = how far axis i is from its face (0 = on the face, 0.5 = mid-axis). The two axes closest
// to their extreme define an edge; if the third axis is ALSO near its extreme, it's a corner.
const CORNER_ZONE = 0.18;
export function nearestElement(local) {
  const p = [local.x, local.y, local.z];
  const s = p.map((v) => (v >= 0 ? '+' : '-'));
  const gap = p.map((v) => 0.5 - Math.abs(v));
  const order = [0, 1, 2].sort((a, b) => gap[a] - gap[b]); // axes sorted most-extreme first
  if (gap[order[2]] < CORNER_ZONE) return `c|${s[0]}${s[1]}${s[2]}`;
  const ax = [order[0], order[1]].sort((a, b) => a - b);   // the edge's two fixed axes
  return `e|${AX[ax[0]]}${AX[ax[1]]}|${s[ax[0]]}${s[ax[1]]}`;
}

// --- geometry: intersect the cube with all active cut planes -----------------------------------

function intersect3(A, B, C) {
  const n1 = A.n, n2 = B.n, n3 = C.n;
  const det = n1.dot(new THREE.Vector3().crossVectors(n2, n3));
  if (Math.abs(det) < 1e-8) return null;
  return new THREE.Vector3()
    .addScaledVector(new THREE.Vector3().crossVectors(n2, n3), A.d)
    .addScaledVector(new THREE.Vector3().crossVectors(n3, n1), B.d)
    .addScaledVector(new THREE.Vector3().crossVectors(n1, n2), C.d)
    .multiplyScalar(1 / det);
}

function geometryFromPlanes(planes) {
  const N = planes.length;
  const verts = [];
  const add = (p) => { for (const q of verts) if (q.distanceToSquared(p) < 1e-8) return; verts.push(p); };
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) for (let k = j + 1; k < N; k++) {
    const p = intersect3(planes[i], planes[j], planes[k]);
    if (!p) continue;
    let inside = true;
    for (let m = 0; m < N; m++) if (planes[m].n.dot(p) > planes[m].d + 1e-5) { inside = false; break; }
    if (inside) add(p);
  }

  const pos = [], nor = [];
  for (const pl of planes) {
    const face = verts.filter((v) => Math.abs(pl.n.dot(v) - pl.d) < 1e-5);
    if (face.length < 3) continue;
    const c = new THREE.Vector3();
    face.forEach((v) => c.add(v));
    c.multiplyScalar(1 / face.length);
    const u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(pl.n.x) > 0.9) u.set(0, 1, 0);
    u.crossVectors(pl.n, u).normalize();
    const w = new THREE.Vector3().crossVectors(pl.n, u);
    face.sort((a, b) => {
      const aa = Math.atan2(w.dot(new THREE.Vector3().subVectors(a, c)), u.dot(new THREE.Vector3().subVectors(a, c)));
      const bb = Math.atan2(w.dot(new THREE.Vector3().subVectors(b, c)), u.dot(new THREE.Vector3().subVectors(b, c)));
      return aa - bb;
    });
    for (let t = 1; t < face.length - 1; t++) {
      let A = face[0], B = face[t], C = face[t + 1];
      const cr = new THREE.Vector3().crossVectors(
        new THREE.Vector3().subVectors(B, A), new THREE.Vector3().subVectors(C, A));
      if (cr.dot(pl.n) < 0) { const s = B; B = C; C = s; } // outward winding
      pos.push(A.x, A.y, A.z, B.x, B.y, B.z, C.x, C.y, C.z);
      for (let r = 0; r < 3; r++) nor.push(pl.n.x, pl.n.y, pl.n.z);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.computeBoundingSphere();
  return g;
}

// build a unit-cube geometry (centred on origin) with the given cuts (Map or object: id -> amount)
export function buildChamferGeometry(cuts) {
  const planes = [
    { n: new THREE.Vector3(1, 0, 0), d: 0.5 }, { n: new THREE.Vector3(-1, 0, 0), d: 0.5 },
    { n: new THREE.Vector3(0, 1, 0), d: 0.5 }, { n: new THREE.Vector3(0, -1, 0), d: 0.5 },
    { n: new THREE.Vector3(0, 0, 1), d: 0.5 }, { n: new THREE.Vector3(0, 0, -1), d: 0.5 },
  ];
  const entries = cuts instanceof Map ? cuts.entries() : Object.entries(cuts);
  for (const [id, a] of entries) if (a > 0) planes.push(elementPlane(id, a));
  return geometryFromPlanes(planes);
}
