// TSL node material: world-space triplanar hatch + per-axis rotation + organic sine-noise
// variation + screen-space Bayer dither in shadow. Output is strictly two-tone (paper / ink).
// Written in TSL so one source compiles to WGSL (WebGPU) and GLSL (WebGL2).
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, vec2, vec3, float, uniform, texture, positionWorld, normalWorld,
  screenCoordinate, abs, dot, max, fract, mix, step, sin, cos, clamp,
  normalize, pow,
} from 'three/tsl';
import { inkColor, paperColor } from './theme.js';

// rotate a 2D coord by a constant angle (constant -> seamless tiling preserved)
const rot = Fn(([p, a]) => {
  const c = cos(a), s = sin(a);
  return vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)));
});

// Sample the hatch tile (alpha = ink coverage) at projected world coords, rotated by a fixed
// per-face angle. Constant rotation + world-space coords -> the pattern tiles seamlessly and
// flows continuously across neighbouring blocks (surface cohesion).
const sampleHatch = Fn(([tex, p, ang, scale]) => {
  return texture(tex, rot(p, ang).mul(scale)).a;
});

export function makeHatchMaterial(hatchTex, bayerTex, opts = {}) {
  const scale = uniform(float(opts.scale ?? 1.0));
  const light = uniform(normalize(vec3(0.55, 0.9, 0.35)));

  const mat = new MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const p = positionWorld;
    const n = normalWorld;
    const an = abs(n);
    // sharpen triplanar weights so each face reads as a single projection
    const w0 = pow(an, vec3(6.0));
    const wsum = w0.x.add(w0.y).add(w0.z).add(1e-4);
    const w = w0.div(wsum);

    // three projections. Diagonal-hatch materials rotate per axis (depth cue); rectilinear
    // materials (brick/stone/wood/liquid) stay axis-aligned so courses read consistently.
    const [rx, ry, rz] = opts.rot ?? [0.0, 0.5, -0.5];
    const sx = sampleHatch(hatchTex, p.zy, float(rx), scale);
    const sy = sampleHatch(hatchTex, p.xz, float(ry), scale);
    const sz = sampleHatch(hatchTex, p.xy, float(rz), scale);
    const cover = sx.mul(w.x).add(sy.mul(w.y)).add(sz.mul(w.z));
    const hatchInk = step(0.3, cover);

    // flat directional tone -> screen-space ordered dither for a stronger depth cue
    const tone = clamp(dot(normalize(n), light).mul(0.5).add(0.5), 0.0, 1.0);
    const shadow = clamp(float(0.95).sub(tone), 0.0, 1.0).mul(0.85);
    const bUV = screenCoordinate.xy.div(8.0);
    const bayer = texture(bayerTex, fract(bUV)).r;
    const ditherInk = step(bayer, shadow);

    const inkAmt = max(hatchInk, ditherInk);
    return mix(paperColor, inkColor, inkAmt);
  })();

  mat.userData.uniforms = { scale, light };
  return mat;
}
