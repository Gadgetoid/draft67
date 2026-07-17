// Palette hotbar + title-block readouts. Swatches reuse the procedural hatch canvases.
import { MATERIALS, makeHatchCanvas } from './materials.js';

export class UI {
  constructor(onSelect) {
    this.onSelect = onSelect;
    this.activeIndex = 0;
    this.byKey = new Map();
    const palette = document.getElementById('palette');

    MATERIALS.forEach((m, i) => {
      const el = document.createElement('div');
      el.className = 'swatch';
      el.title = m.name;
      // The hatch pattern (deterministic, black-on-transparent) is used as an alpha mask over an
      // ink-coloured fill, so the swatch recolours with the theme via CSS instead of a fixed image.
      const art = document.createElement('span');
      art.className = 'swatch-art';
      const url = makeHatchCanvas(m, 96).toDataURL();
      art.style.webkitMaskImage = `url(${url})`;
      art.style.maskImage = `url(${url})`;
      el.appendChild(art);
      if (m.key) {
        const key = document.createElement('span');
        key.className = 'key';
        key.textContent = m.key;
        el.appendChild(key);
        this.byKey.set(m.key, i);
      }
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = m.name;
      el.appendChild(label);
      el.addEventListener('click', () => this.select(i));
      palette.appendChild(el);
      m._el = el;
    });

    this.tbMode = document.getElementById('tb-mode');
    this.tbMaterial = document.getElementById('tb-material');
    this.tbCount = document.getElementById('tb-count');
    this.tbBackend = document.getElementById('tb-backend');
    this.select(0);
  }

  select(i) {
    if (i < 0 || i >= MATERIALS.length) return;
    MATERIALS[this.activeIndex]._el.classList.remove('active');
    this.activeIndex = i;
    MATERIALS[i]._el.classList.add('active');
    this.tbMaterial.textContent = MATERIALS[i].name;
    this.onSelect?.(MATERIALS[i].id);
  }
  selectByKey(k) { if (this.byKey.has(k)) this.select(this.byKey.get(k)); }
  get material() { return MATERIALS[this.activeIndex].id; }

  setMode(m) { this.tbMode.textContent = m.toUpperCase(); }
  setCount(n) { this.tbCount.textContent = n; }
  setBackend(b) { this.tbBackend.textContent = b; }
}
