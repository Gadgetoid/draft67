// Shared ink/paper colours used across the hatch, outline and grid shaders so a single toggle
// recolours the whole scene live. Strictly two-tone: every rendered pixel is either paper or ink.
// This registry is the single source of truth - the shader uniforms, the CSS chrome and the menu
// picker all derive from it, so a new theme is just one more entry below.
import * as THREE from 'three';
import { uniform } from 'three/tsl';

export const inkColor = uniform(new THREE.Vector3());
export const paperColor = uniform(new THREE.Vector3());

// Each theme is two authored sRGB swatches: ink (lines) on paper (fill / background).
export const THEMES = {
  paper: { label: 'Paper', ink: '#14110b', paper: '#f2e9d0' },
  blueprint: { label: 'Blueprint', ink: '#a6c1ef', paper: '#0f3b74' },
  console: { label: 'Console', ink: '#33ff33', paper: '#0a0f0a' },
  cga: { label: 'CGA', ink: '#2ee6e6', paper: '#b800b8' },
};
export const THEME_NAMES = Object.keys(THEMES);

let current = 'paper';
const _c = new THREE.Color();

function linear(hex) { _c.set(hex); return [_c.r, _c.g, _c.b]; }

export function applyTheme(name, scene) {
  const t = THEMES[name] || THEMES.paper;
  current = THEMES[name] ? name : 'paper';
  // Shader nodes are linear and sRGB-encoded on output, so feed the linearised swatches; this keeps
  // the rendered paper/ink matched to the scene background and the CSS chrome.
  paperColor.value.set(...linear(t.paper));
  inkColor.value.set(...linear(t.ink));
  if (scene) {
    if (!scene.background) scene.background = new THREE.Color();
    scene.background.set(t.paper);
  }
  document.documentElement.dataset.theme = current;
}

export function toggleTheme(scene) {
  const i = THEME_NAMES.indexOf(current);
  applyTheme(THEME_NAMES[(i + 1) % THEME_NAMES.length], scene);
  return current;
}

export const currentTheme = () => current;
