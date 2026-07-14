// Camera rig: orbit builder (default) <-> first-person fly, toggleable.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

export class CameraRig {
  constructor(camera, dom, world) {
    this.camera = camera;
    this.dom = dom;
    this.world = world;                // for first-person walk-mode collision (world.has)
    this.mode = 'orbit';

    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.target.set(0, 0, 0);
    // Left = orbit, Middle = pan, Right = free (used for block removal, no accidental pan).
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };

    this.fp = new PointerLockControls(camera, dom);
    this.fp.enabled = false;

    // Orthographic blueprint camera + its own orbit controls (used in blueprint preview mode).
    this.blueprint = false;
    this.ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 4000);
    this.orthoHalf = 10;
    this.orthoOrbit = new OrbitControls(this.ortho, dom);
    this.orthoOrbit.enableDamping = true;
    this.orthoOrbit.dampingFactor = 0.12;
    this.orthoOrbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
    this.orthoOrbit.enabled = false;

    this.keys = new Set();
    this.speed = 6; // world units / sec
    this.lookSpeed = 1.7; // rad / sec for arrow-key look
    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));

    // First-person walk mode (double-tap Space to toggle): gravity + AABB voxel collision.
    this.walk = false;
    this.velY = 0;
    this.grounded = false;
    this._spaceDown = false;
    this._lastTap = -1e9;
    this.eye = 1.6;        // camera height above the player's feet
    this.bodyH = 1.7;      // feet-to-head
    this.half = 0.3;       // horizontal half-width of the player box
    this.walkSpeed = 4.5;
    this.gravity = 22;     // u/s^2
    this.jumpSpeed = 7.8;  // -> apex ~1.38u, enough to leap onto a 1-block ledge
    this.groundY = -0.5;   // the build plane acts as a floor

    this._tmp = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._move = new THREE.Vector3();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  // WASD pans the camera across its view plane (A/D along camera-right, W/S along camera-up),
  // moving camera and orbit target together so the view angle and distance are preserved. It does
  // NOT dolly in/out along the forward axis. Used in orbit mode.
  _flyOrbit(dt) {
    const k = this.keys;
    let u = 0, s = 0;
    if (k.has('KeyW')) u += 1;
    if (k.has('KeyS')) u -= 1;
    if (k.has('KeyD')) s += 1;
    if (k.has('KeyA')) s -= 1;
    if (!u && !s) return;
    const d = this.speed * dt;
    this.camera.updateMatrixWorld();
    this._right.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize(); // camera right
    this._up.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();    // camera up
    this._move.set(0, 0, 0)
      .addScaledVector(this._up, u * d)
      .addScaledVector(this._right, s * d);
    this.camera.position.add(this._move);
    this.orbit.target.add(this._move);
  }

  // --- first-person movement ---------------------------------------------------------------

  // WASD fly + Space/Ctrl vertical (no physics)
  _flyMove(dt) {
    const d = this.speed * dt, k = this.keys;
    if (k.has('KeyW')) this.fp.moveForward(d);
    if (k.has('KeyS')) this.fp.moveForward(-d);
    if (k.has('KeyD')) this.fp.moveRight(d);
    if (k.has('KeyA')) this.fp.moveRight(-d);
    if (k.has('Space')) this.camera.position.y += d;
    if (k.has('ControlLeft') || k.has('ShiftLeft')) this.camera.position.y -= d;
  }

  _arrowLook(dt) {
    const k = this.keys;
    let ry = 0, rx = 0;
    if (k.has('ArrowLeft')) ry += 1;
    if (k.has('ArrowRight')) ry -= 1;
    if (k.has('ArrowUp')) rx += 1;
    if (k.has('ArrowDown')) rx -= 1;
    if (!ry && !rx) return;
    const look = this.lookSpeed * dt;
    const maxX = Math.PI / 2 - 0.02;
    this._euler.setFromQuaternion(this.camera.quaternion);
    this._euler.y += ry * look;
    this._euler.x = Math.max(-maxX, Math.min(maxX, this._euler.x + rx * look));
    this.camera.quaternion.setFromEuler(this._euler);
  }

  // double-tap Space toggles walk/fly; a single tap in walk mode jumps
  _handleSpace() {
    const down = this.keys.has('Space');
    if (down && !this._spaceDown) {
      const t = performance.now();
      if (t - this._lastTap < 300) { this.walk = !this.walk; this.velY = 0; this._lastTap = -1e9; }
      else { this._lastTap = t; if (this.walk && this.grounded) { this.velY = this.jumpSpeed; this.grounded = false; } }
    }
    this._spaceDown = down;
  }

  // integer voxel cells spanned by a world-coord range [lo, hi] (cells are unit cubes centred on ints)
  _cells(lo, hi) { const E = 1e-4; return [Math.floor(lo + 0.5 + E), Math.floor(hi + 0.5 - E)]; }

  // move the player AABB (min/max) along one axis, clamping against solid voxels; returns actual delta
  _sweep(min, max, a, d) {
    const STEP = 0.4; // substep so fast moves can't tunnel through a block
    let remaining = d, applied = 0;
    while (Math.abs(remaining) > 1e-6) {
      const step = Math.abs(remaining) > STEP ? Math.sign(remaining) * STEP : remaining;
      const got = this._sweepStep(min, max, a, step);
      applied += got;
      if (Math.abs(got - step) > 1e-6) break; // blocked
      remaining -= step;
    }
    return applied;
  }

  _sweepStep(min, max, a, d) {
    const p1 = (a + 1) % 3, p2 = (a + 2) % 3;
    const before = min[a];
    min[a] += d; max[a] += d;
    const [j0, j1] = this._cells(min[p1], max[p1]);
    const [k0, k1] = this._cells(min[p2], max[p2]);
    const [i0, i1] = this._cells(min[a], max[a]);
    let hit = false, face = d > 0 ? Infinity : -Infinity;
    const c = [0, 0, 0];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
      c[a] = i; c[p1] = j; c[p2] = k;
      if (this.world.has(c[0], c[1], c[2])) {
        hit = true;
        face = d > 0 ? Math.min(face, i - 0.5) : Math.max(face, i + 0.5);
      }
    }
    if (hit) {
      const shift = d > 0 ? (face - 1e-4) - max[a] : (face + 1e-4) - min[a];
      min[a] += shift; max[a] += shift;
    }
    return min[a] - before;
  }

  _walkUpdate(dt) {
    const k = this.keys;
    let f = 0, s = 0;
    if (k.has('KeyW')) f += 1;
    if (k.has('KeyS')) f -= 1;
    if (k.has('KeyD')) s += 1;
    if (k.has('KeyA')) s -= 1;
    this._euler.setFromQuaternion(this.camera.quaternion);
    const sin = Math.sin(this._euler.y), cos = Math.cos(this._euler.y);
    let vx = -sin * f + cos * s;   // camera-relative horizontal (yaw only)
    let vz = -cos * f - sin * s;
    const len = Math.hypot(vx, vz);
    if (len > 1e-6) { vx = (vx / len) * this.walkSpeed; vz = (vz / len) * this.walkSpeed; } else { vx = vz = 0; }

    this.velY = Math.max(this.velY - this.gravity * dt, -40);

    const P = this.camera.position;
    const min = [P.x - this.half, P.y - this.eye, P.z - this.half];
    const max = [P.x + this.half, P.y - this.eye + this.bodyH, P.z + this.half];
    this._sweep(min, max, 0, vx * dt);
    this._sweep(min, max, 2, vz * dt);
    const want = this.velY * dt;
    const got = this._sweep(min, max, 1, want);
    this.grounded = false;
    if (this.velY < 0 && got > want + 1e-5) { this.grounded = true; this.velY = 0; }   // landed
    else if (this.velY > 0 && got < want - 1e-5) { this.velY = 0; }                      // bonked head
    if (min[1] < this.groundY) { const sft = this.groundY - min[1]; min[1] += sft; max[1] += sft; this.grounded = true; this.velY = 0; }
    P.set(min[0] + this.half, min[1] + this.eye, min[2] + this.half);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'fp') {
      this.orbit.enabled = false;
      this.fp.enabled = true;
      document.body.classList.add('fp');
    } else {
      this.fp.enabled = false;
      if (this.fp.isLocked) this.fp.unlock();
      // Keep the current view: orbit around a point in front of where the camera looks, so
      // returning from first-person doesn't snap/flip to a stale target.
      this.camera.getWorldDirection(this._tmp);
      this.orbit.target.copy(this.camera.position).addScaledVector(this._tmp, 8);
      this.orbit.enabled = true;
      document.body.classList.remove('fp');
    }
  }
  toggle() { this.setMode(this.mode === 'orbit' ? 'fp' : 'orbit'); }

  get activeCamera() { return this.blueprint ? this.ortho : this.camera; }

  // Enter orthographic blueprint preview, framed on the model, matching the current view angle.
  enterBlueprint(center, radius) {
    if (this.mode === 'fp') this.setMode('orbit'); // normalize so exiting blueprint restores cleanly
    this.blueprint = true;
    this.orbit.enabled = false;
    this.fp.enabled = false;
    if (this.fp.isLocked) this.fp.unlock();

    this._frameRadius = radius * 1.25 + 1;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);              // current view direction
    const dist = radius * 6 + 20;
    this.ortho.position.copy(center).addScaledVector(dir, -dist);
    this.ortho.up.set(0, 1, 0);
    this.ortho.lookAt(center);
    this.orthoOrbit.target.copy(center);
    this.orthoOrbit.enabled = true;
    document.body.classList.add('blueprint');
  }

  exitBlueprint() {
    this.blueprint = false;
    this.orthoOrbit.enabled = false;
    if (this.mode === 'orbit') this.orbit.enabled = true;
    document.body.classList.remove('blueprint');
  }

  // Snap the ortho blueprint camera to a viewing direction (unit vector from target to camera).
  snapBlueprint(dir) {
    if (!this.blueprint) return;
    const target = this.orthoOrbit.target;
    const dist = (this._frameRadius || 10) * 6 + 20;
    const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
    this.ortho.position.copy(target).addScaledVector(d, dist);
    // avoid gimbal lock when looking straight up/down
    this.ortho.up.set(0, 1, 0);
    if (Math.abs(d.y) > 0.999) this.ortho.up.set(0, 0, d.y > 0 ? -1 : 1);
    this.ortho.lookAt(target);
    this.orthoOrbit.update();
  }

  // azimuth/polar of the current blueprint camera, for syncing an orientation gizmo
  get orthoAngles() {
    return { azimuth: this.orthoOrbit.getAzimuthalAngle(), polar: this.orthoOrbit.getPolarAngle() };
  }

  // keep the ortho frustum square-to-aspect
  applyOrthoAspect(aspect) {
    const h = this._frameRadius || this.orthoHalf;
    this.ortho.left = -h * aspect; this.ortho.right = h * aspect;
    this.ortho.top = h; this.ortho.bottom = -h;
    this.ortho.updateProjectionMatrix();
  }

  update(dt) {
    if (this.blueprint) { this.orthoOrbit.update(); return; }
    if (this.mode === 'orbit') { this._flyOrbit(dt); this.orbit.update(); return; }
    if (!this.fp.isLocked) return;
    this._handleSpace();          // double-tap toggle walk/fly, single-tap jump
    this._arrowLook(dt);
    const dtc = Math.min(dt, 0.05); // clamp so a stutter can't fling the player through geometry
    if (this.walk && this.world) this._walkUpdate(dtc);
    else this._flyMove(dtc);
  }
}
