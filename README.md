# Draft'67 - a 1-bit voxel drafting engine

(Draft siiixxx seeeven†. [Try it out for yourself!](https://gadgetoid.github.io/draft67/))

Build in 3D with the visual language of an old engineering drawing. Every block is skinned in a
conventional draughting **cross-hatch** (cast iron, steel, brass, copper, wood, brick, stone,
glass, and more) rendered strictly in two tones: ink on paper, or white on blueprint blue.
Place and remove blocks, fly around, and export a clean orthographic **blueprint** of your model.

![Draft'67 in both themes, paper and blueprint, split down the middle](screenshot.png)

† - blame my kids

## Inspiration

The look is heavily inspired by a **Bluesky post** that shared a plate of *"Conventional Standard
Cross-Hatchings"* from an old drafting / mechanical-drawing textbook: the standardised line-fill
patterns draughtsmen used to indicate materials in section. Draft'67 takes those 2D material
conventions and wraps them around 3D voxels.

![The full material palette, one block per type, rendered by the engine's blueprint export](preview.png)

(M. C. Escher would be proud.)

## Running it

Needs [Node.js](https://nodejs.org/). Then:

```bash
npm install
npm run dev      # local dev server (opens the browser)
npm run build    # static production build -> dist/
```

It runs in any modern browser via Three.js's `WebGPURenderer`, using **WebGPU** where available and
falling back to **WebGL2** automatically. The current backend is shown in the title block.

A GitHub Actions workflow (`.github/workflows/deploy.yml`) builds and publishes to GitHub Pages on
every push to `main` (set the repo's Pages source to "GitHub Actions").

The README images are rendered by the engine itself. Regenerate the hero with `npm run hero` (needs
the dev server running and a one-time `npx playwright install chromium`).

## Controls

**Camera:** `Tab` toggles between Orbit and First-person.

| | Orbit | First-person |
|---|---|---|
| Look | LMB drag | move mouse (click to capture) / `Arrow` keys |
| Move | `WASD` pan (across the view plane) | `WASD` move, `Space`/`Ctrl` up-down |
| Pan / zoom | MMB drag / scroll | n/a |

**Building**

- **LMB** places a block. **RMB** or **Shift-LMB** removes a block.
- In first-person you can **hold** the button and sweep the crosshair (with the mouse or the arrow
  keys) to paint a run of blocks; erasing is rate-limited so a sweep doesn't clear a whole row.
- There's always a ground plane to place the first block on.
- **Materials:** number keys `1 2 3 4 5 6 7 8 9 0` then `Y U I O P`, in palette order, or click a
  swatch in the hotbar.

**Toolbar**

- **Orbit / First-person:** camera toggle (same as `Tab`).
- **Blueprint:** toggle the paper / blueprint-blue theme.
- **Preview:** enter the orthographic **blueprint preview**: grid hidden, orbit or use the
  **orientation cube** (click a face, or ISO) to snap to a cardinal view, then **Export PNG** a
  1-bit blueprint of the model. **Exit** (or `Esc`) to return.
- **Save / Load:** download / upload the model as JSON (also autosaved to `localStorage`).
- **Clear:** remove all blocks.

## How it works

- **Voxels** live in a map keyed by integer coordinates; each material is drawn with its own
  `InstancedMesh`, edited incrementally (append / swap-remove) so placing and removing stays O(1).
- **Hatch textures** are generated procedurally per material as seamless tiles, then sampled
  **triplanar in world space** so neighbouring same-material blocks merge into one continuous drawn
  surface. Diagonal metal hatches rotate per face to imply depth; rectilinear materials (brick,
  stone, wood, liquid) stay axis-aligned so courses wrap cleanly around corners.
- **Shading** is strictly two-tone: a screen-space ordered (Bayer) dither darkens faces in shadow
  without introducing greys.
- **Outlines** come from a screen-space pass that inks edges where surface normal, depth, or
  **material id** breaks, so silhouettes, creases, and boundaries between different materials are
  drawn, but the internal seams of a merged surface are not.
- **Theme** colours are shared shader uniforms, so one toggle recolours the whole scene live.
- Shaders are written in **TSL** (Three Shading Language) so a single source compiles to both WGSL
  (WebGPU) and GLSL (WebGL2).

## License

Released under **[CC0 1.0 Universal](LICENSE)**: public domain, no rights reserved. Do whatever
you like with it.
