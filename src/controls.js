// Camera rig: orbit builder (default) <-> first-person fly, toggleable.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

export class CameraRig {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
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
    const d = this.speed * dt;
    const k = this.keys;
    if (k.has('KeyW')) this.fp.moveForward(d);
    if (k.has('KeyS')) this.fp.moveForward(-d);
    if (k.has('KeyD')) this.fp.moveRight(d);
    if (k.has('KeyA')) this.fp.moveRight(-d);
    if (k.has('Space')) this.camera.position.y += d;
    if (k.has('ControlLeft') || k.has('ShiftLeft')) this.camera.position.y -= d;

    // Arrow keys look around too, so you can hold-paint and sweep the crosshair over cells.
    let ry = 0, rx = 0;
    if (k.has('ArrowLeft')) ry += 1;
    if (k.has('ArrowRight')) ry -= 1;
    if (k.has('ArrowUp')) rx += 1;
    if (k.has('ArrowDown')) rx -= 1;
    if (ry || rx) {
      const look = this.lookSpeed * dt;
      const maxX = Math.PI / 2 - 0.02;
      this._euler.setFromQuaternion(this.camera.quaternion);
      this._euler.y += ry * look;
      this._euler.x = Math.max(-maxX, Math.min(maxX, this._euler.x + rx * look));
      this.camera.quaternion.setFromEuler(this._euler);
    }
  }
}
