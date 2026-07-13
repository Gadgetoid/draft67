// Procedural hatch textures inspired by "Conventional Standard Cross-Hatchings, Plate A".
// Each material draws a SEAMLESSLY TILEABLE black-on-transparent line pattern that is sampled
// triplanar in world space by the hatch shader, so adjacent blocks merge into one drawn surface.
import * as THREE from 'three';

export const TILE = 128; // px; spacings below divide this for seamless wrap

const INK = '#14110b';

// --- low-level seamless drawing helpers -------------------------------------

// Draw a family of parallel lines that tiles the TILE square seamlessly.
// kind: '-' horizontal (y=k·period) · '|' vertical (x=k·period) ·
//       '/' diagonal (x−y=k·period) · '\\' diagonal (x+y=k·period).
// For seamless wrap `period` MUST divide TILE (e.g. 8, 16, 32) — this guarantees the
// pattern is invariant under (TILE,0) and (0,TILE), unlike rotate-then-space diagonals.
function hatch(ctx, kind, period, weight, dash) {
  ctx.save();
  ctx.strokeStyle = INK;
  ctx.lineWidth = weight;
  ctx.lineCap = 'butt';
  if (dash) ctx.setLineDash(dash);
  const T = TILE, ext = T; // extend beyond edges so wrapped lines meet cleanly
  if (kind === '-') {
    for (let y = 0; y < T; y += period) {
      ctx.beginPath(); ctx.moveTo(-ext, y); ctx.lineTo(T + ext, y); ctx.stroke();
    }
  } else if (kind === '|') {
    for (let x = 0; x < T; x += period) {
      ctx.beginPath(); ctx.moveTo(x, -ext); ctx.lineTo(x, T + ext); ctx.stroke();
    }
  } else {
    const sign = kind === '\\' ? 1 : -1; // x + sign·y = c  ->  y = sign·(c − x)
    for (let c = -T; c <= 2 * T; c += period) {
      const x0 = -ext, x1 = T + ext;
      ctx.beginPath();
      ctx.moveTo(x0, sign * (c - x0));
      ctx.lineTo(x1, sign * (c - x1));
      ctx.stroke();
    }
  }
  ctx.restore();
}

function fillDots(ctx, count, r, seed) {
  ctx.fillStyle = INK;
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < count; i++) {
    const x = rnd() * TILE, y = rnd() * TILE;
    const rr = r * (0.4 + rnd());
    // draw with wrap so dots crossing the edge appear on both sides
    for (const dx of [-TILE, 0, TILE]) for (const dy of [-TILE, 0, TILE]) {
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, rr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// horizontal courses (brick / stone / liquid); rows evenly divide TILE
function courses(ctx, rows, weight) {
  const h = TILE / rows;
  hatch(ctx, '-', h, weight);
  return h;
}

// --- material catalogue ------------------------------------------------------
// key: hotbar digit. draw(ctx): paints one seamless tile on a transparent canvas.

export const MATERIALS = [
  // NOTE: hatch `period` MUST divide TILE (128) so patterns wrap seamlessly: 8, 16, 32.
  {
    id: 'cast_iron', name: 'CAST IRON', key: '1',
    draw: (c) => hatch(c, '/', 16, 2.4),
  },
  {
    id: 'steel', name: 'STEEL', key: '2',
    draw: (c) => hatch(c, '/', 16, 4.6),
  },
  {
    id: 'brass', name: 'BRASS', key: '3',
    draw: (c) => hatch(c, '/', 16, 2.2, [12, 6, 2, 6]),
  },
  {
    id: 'bronze', name: 'BRONZE', key: '4',
    draw: (c) => hatch(c, '/', 16, 2.0, [10, 6]),
  },
  {
    id: 'aluminum', name: 'ALUMINUM', key: '',
    draw: (c) => hatch(c, '/', 16, 1.6, [5, 6]),
  },
  {
    id: 'copper', name: 'COPPER', key: '5',
    draw: (c) => { hatch(c, '/', 16, 1.9); hatch(c, '\\', 16, 1.9); },
  },
  {
    id: 'bearing', name: 'BEARING', key: '6',
    draw: (c) => { hatch(c, '/', 8, 1.6); hatch(c, '\\', 8, 1.6); },
  },
  {
    id: 'wires', name: 'WIRES', key: '',
    draw: (c) => { hatch(c, '/', 8, 0.8); hatch(c, '\\', 8, 0.8); },
  },
  {
    id: 'vulcanite', name: 'VULCANITE', key: '',
    draw: (c) => hatch(c, '/', 8, 5.5), // heavy, nearly-solid diagonal
  },
  {
    id: 'wood', name: 'WOOD', key: '7', align: true,
    draw: (c) => {
      // grain: gently wavy horizontal lines
      c.strokeStyle = INK; c.lineWidth = 1.8;
      const rows = 8, h = TILE / rows; // 8 divides TILE -> tiles vertically
      for (let i = 0; i < rows; i++) {
        const y0 = i * h + h * 0.5;
        c.beginPath();
        for (let x = 0; x <= TILE; x += 4) {
          // full-period sine so the grain matches at x=0 and x=TILE
          const y = y0 + Math.sin((x / TILE) * Math.PI * 2 + i) * (h * 0.18);
          x === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
        }
        c.stroke();
      }
    },
  },
  {
    id: 'brick', name: 'BRICK', key: '8', align: true,
    draw: (c) => {
      const rows = 4, h = courses(c, rows, 1.7);
      const bw = TILE / 2; // brick = half a tile wide; running bond offsets alternate rows
      c.strokeStyle = INK; c.lineWidth = 1.5;
      for (let i = 0; i < rows; i++) {
        const y = i * h, off = (i % 2) * (bw / 2); // 0 or quarter-tile -> overlapping courses
        for (let x = off; x < TILE + off; x += bw) {
          const xx = ((x % TILE) + TILE) % TILE;
          c.beginPath(); c.moveTo(xx, y); c.lineTo(xx, y + h); c.stroke();
        }
      }
    },
  },
  {
    id: 'stone', name: 'STONE', key: '9', align: true,
    draw: (c) => {
      const rows = 4, h = courses(c, rows, 1.6);
      let s = 7; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      // irregular vertical joints splitting each course into rough stones
      c.lineWidth = 1.3;
      const stones = []; // {x0,x1,y0,y1}
      for (let i = 0; i < rows; i++) {
        const y = i * h;
        let x = (i % 2 ? TILE * 0.28 : TILE * 0.62), prev = 0;
        while (x < TILE) {
          c.beginPath(); c.moveTo(x, y); c.lineTo(x + (rnd() - 0.5) * 8, y + h); c.stroke();
          stones.push({ x0: prev, x1: x, y0: y, y1: y + h }); prev = x;
          x += TILE * (0.28 + rnd() * 0.22);
        }
        stones.push({ x0: prev, x1: TILE, y0: y, y1: y + h });
      }
      // rustic short cross-hatch clusters inside each stone (as in the plate)
      c.lineWidth = 0.9; c.lineCap = 'round';
      for (const st of stones) {
        const cx = st.x0 + (st.x1 - st.x0) * (0.3 + rnd() * 0.4);
        const cy = st.y0 + h * (0.3 + rnd() * 0.4);
        const n = 2 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) {
          const o = (k - n / 2) * 3;
          c.beginPath(); c.moveTo(cx + o, cy - 4); c.lineTo(cx + o + 5, cy + 4); c.stroke();
        }
      }
    },
  },
  {
    id: 'glass', name: 'GLASS', key: '0',
    draw: (c) => {
      // scattered short diagonal groups (drawn with wrap so they tile seamlessly)
      c.strokeStyle = INK; c.lineWidth = 1.3;
      let s = 3; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      for (let g = 0; g < 9; g++) {
        const gx = rnd() * TILE, gy = rnd() * TILE;
        for (const dx of [-TILE, 0, TILE]) for (const dy of [-TILE, 0, TILE]) {
          for (let k = 0; k < 4; k++) {
            const x = gx + dx + k * 4, y = gy + dy + k * 2;
            c.beginPath(); c.moveTo(x, y); c.lineTo(x + 12, y - 12); c.stroke();
          }
        }
      }
    },
  },
  {
    id: 'liquid', name: 'LIQUID', key: '', align: true, // clickable only
    draw: (c) => courses(c, 8, 1.3),
  },
  {
    id: 'leather', name: 'LEATHER', key: '',
    draw: (c) => {
      // fine random short strokes (the "grain") + a few larger filled specks
      c.strokeStyle = INK; c.lineWidth = 1.0; c.lineCap = 'round';
      let s = 11; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      for (let i = 0; i < 300; i++) {
        const x = rnd() * TILE, y = rnd() * TILE, a = rnd() * Math.PI, len = 2 + rnd() * 3;
        const dx = Math.cos(a) * len, dy = Math.sin(a) * len;
        for (const ox of [-TILE, 0, TILE]) for (const oy of [-TILE, 0, TILE]) {
          c.beginPath(); c.moveTo(x + ox, y + oy); c.lineTo(x + ox + dx, y + oy + dy); c.stroke();
        }
      }
      c.fillStyle = INK;
      for (let i = 0; i < 6; i++) {
        const x = rnd() * TILE, y = rnd() * TILE, r = 2 + rnd() * 2.4;
        for (const ox of [-TILE, 0, TILE]) for (const oy of [-TILE, 0, TILE]) {
          c.beginPath(); c.arc(x + ox, y + oy, r, 0, Math.PI * 2); c.fill();
        }
      }
    },
  },
];

// Draw one material into a fresh transparent canvas.
export function makeHatchCanvas(material, size = TILE) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.scale(size / TILE, size / TILE);
  material.draw(ctx);
  return cv;
}

// Faint drafting graph-paper grid for the build plane (also the pick surface when empty).
export function makeGridTexture(cells = 1) {
  const px = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, px, px);
  ctx.strokeStyle = 'rgba(20,17,11,0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, px, px); // one cell border -> continuous grid when tiled
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// A CanvasTexture (repeat-wrapped) for use as the shader hatch source.
export function makeHatchTexture(material) {
  const tex = new THREE.CanvasTexture(makeHatchCanvas(material, TILE));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// 8x8 ordered (Bayer) dither matrix as a DataTexture, values 0..1, nearest, repeated.
export function makeBayerTexture() {
  const n = 8;
  const base = [
    0, 32, 8, 40, 2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37,
    63, 31, 55, 23, 61, 29, 53, 21,
  ];
  const data = new Uint8Array(n * n);
  for (let i = 0; i < base.length; i++) data[i] = Math.floor((base[i] / 64) * 255);
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export const PAPER = new THREE.Color('#f2e9d0');
export const INK_COLOR = new THREE.Color('#14110b');
