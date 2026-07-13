// Ink outlines via screen-space edge detection over three g-buffers:
//   colorRT  : the hatch render (paper/ink)
//   dataRT   : rgb = view normal, a = scaled linear depth  (silhouettes + creases)
//   idRT     : r = flat per-material id                    (boundaries between merged regions)
// Coplanar SAME-material neighbours share normal+depth+id -> no seam line (surface cohesion),
// while different-material regions and real geometric edges are inked.
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, vec2, vec4, uniform, texture, uv, normalView, positionView,
  abs, max, clamp, mix, step, length,
} from 'three/tsl';
import { inkColor } from './theme.js';

export class OutlinePipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.w = 1; this.h = 1;
    this.colorRT = new THREE.RenderTarget(1, 1);
    this.dataRT = new THREE.RenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.idRT = new THREE.RenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });

    // g-buffer: rgb = view normal (0..1), a = scaled linear depth
    this.gbuffer = new MeshBasicNodeMaterial();
    this.gbuffer.colorNode = Fn(() => {
      const n = normalView.mul(0.5).add(0.5);
      const d = clamp(positionView.z.negate().mul(0.02), 0.0, 1.0);
      return vec4(n, d);
    })();

    const texel = uniform(vec2(1, 1));
    this.texel = texel;

    const comp = new MeshBasicNodeMaterial();
    comp.colorNode = Fn(() => {
      // render-target samples are V-flipped vs. screen -> flip once here
      const suv = vec2(uv().x, uv().y.oneMinus());
      const ox = vec2(texel.x, 0), oy = vec2(0, texel.y);
      const sample = (t, o) => texture(t, suv.add(o));

      const co = sample(this.colorRT.texture, vec2(0, 0));

      // normal + depth edges
      const c = sample(this.dataRT.texture, vec2(0, 0));
      const l = sample(this.dataRT.texture, ox.negate());
      const r = sample(this.dataRT.texture, ox);
      const d = sample(this.dataRT.texture, oy.negate());
      const u = sample(this.dataRT.texture, oy);
      const nEdge = max(max(length(l.xyz.sub(r.xyz)), length(d.xyz.sub(u.xyz))), length(c.xyz.sub(r.xyz)));
      const dEdge = max(abs(l.w.sub(r.w)), abs(d.w.sub(u.w))).mul(6.0);

      // material-id edges (outline each merged region, even when coplanar)
      const il = sample(this.idRT.texture, ox.negate()).r;
      const ir = sample(this.idRT.texture, ox).r;
      const iu = sample(this.idRT.texture, oy).r;
      const idd = sample(this.idRT.texture, oy.negate()).r;
      const idEdge = max(abs(il.sub(ir)), abs(iu.sub(idd))).mul(40.0);

      const edge = step(0.4, max(max(nEdge, dEdge), idEdge));
      return vec4(mix(co.xyz, inkColor, edge), 1.0);
    })();

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), comp);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  setSize(w, h) {
    this.w = Math.max(1, w | 0); this.h = Math.max(1, h | 0);
    this.colorRT.setSize(this.w, this.h);
    this.dataRT.setSize(this.w, this.h);
    this.idRT.setSize(this.w, this.h);
    this.texel.value.set(1 / this.w, 1 / this.h);
  }

  // hide objects that must not be ink-outlined (e.g. the reference grid) during the edge passes
  _hideExcluded(scene) {
    const hidden = [];
    scene.traverse((o) => { if (o.userData.excludeFromOutline && o.visible) { o.visible = false; hidden.push(o); } });
    return hidden;
  }

  async render(scene, camera) {
    const r = this.renderer;

    // 1) hatch color (grid IS drawn here)
    r.setRenderTarget(this.colorRT);
    await r.renderAsync(scene, camera);

    // grid must not participate in edge detection -> hide it for the gbuffer/id passes
    const hidden = this._hideExcluded(scene);

    // 2) view normal + depth
    scene.overrideMaterial = this.gbuffer;
    r.setRenderTarget(this.dataRT);
    await r.renderAsync(scene, camera);
    scene.overrideMaterial = null;

    // 3) flat per-material id (swap each mesh to its id material, then restore)
    const swapped = [];
    scene.traverse((o) => {
      if (o.isInstancedMesh && o.userData.idMaterial) {
        swapped.push([o, o.material]);
        o.material = o.userData.idMaterial;
      }
    });
    r.setRenderTarget(this.idRT);
    await r.renderAsync(scene, camera);
    for (const [o, m] of swapped) o.material = m;

    for (const o of hidden) o.visible = true;

    // 4) composite to screen
    r.setRenderTarget(null);
    await r.renderAsync(this.quadScene, this.quadCam);
  }

  // Render the full outlined composite into a fresh high-res RenderTarget (for PNG export).
  async renderToRT(scene, camera, w, h) {
    const prevW = this.w, prevH = this.h;
    this.setSize(w, h);
    const finalRT = new THREE.RenderTarget(w, h);
    const r = this.renderer;

    r.setRenderTarget(this.colorRT);
    await r.renderAsync(scene, camera);

    const hidden = this._hideExcluded(scene);

    scene.overrideMaterial = this.gbuffer;
    r.setRenderTarget(this.dataRT);
    await r.renderAsync(scene, camera);
    scene.overrideMaterial = null;

    const swapped = [];
    scene.traverse((o) => {
      if (o.isInstancedMesh && o.userData.idMaterial) { swapped.push([o, o.material]); o.material = o.userData.idMaterial; }
    });
    r.setRenderTarget(this.idRT);
    await r.renderAsync(scene, camera);
    for (const [o, m] of swapped) o.material = m;

    for (const o of hidden) o.visible = true;

    r.setRenderTarget(finalRT);
    await r.renderAsync(this.quadScene, this.quadCam);
    r.setRenderTarget(null);

    this.setSize(prevW, prevH);
    return finalRT;
  }
}
