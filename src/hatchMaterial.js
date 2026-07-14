// TSL node material: world-space triplanar hatch + per-axis rotation + organic sine-noise
// variation + screen-space Bayer dither in shadow. Output is strictly two-tone (paper / ink).
// Written in TSL so one source compiles to WGSL (WebGPU) and GLSL (WebGL2).
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, vec2, vec3, float, uniform, texture, positionWorld, normalWorld,
  screenCoordinate, abs, dot, max, fract, mix, step, sin, cos, clamp,
  normalize,
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
    // HARD-select the single dominant axis (not a blend), so an angled chamfer face shows one clean
    // hatch instead of two/three overlapping projections. The tiny per-axis bias gives a decisive
    // priority (x > y > z) so a 45-degree tie resolves cleanly instead of fighting.
    const an = abs(n).mul(vec3(1.0, 0.999, 0.998));
    const wx = step(an.y, an.x).mul(step(an.z, an.x));
    const wy = step(an.z, an.y).mul(step(an.x, an.y)).mul(wx.oneMinus());
    const wz = wx.oneMinus().mul(wy.oneMinus());

    // three projections. Diagonal-hatch materials rotate per axis (depth cue); rectilinear
    // materials (brick/stone/wood/liquid) stay axis-aligned so courses read consistently.
    const [rx, ry, rz] = opts.rot ?? [0.0, 0.5, -0.5];
    const sx = sampleHatch(hatchTex, p.zy, float(rx), scale);
    const sy = sampleHatch(hatchTex, p.xz, float(ry), scale);
    const sz = sampleHatch(hatchTex, p.xy, float(rz), scale);
    const cover = sx.mul(wx).add(sy.mul(wy)).add(sz.mul(wz));
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
