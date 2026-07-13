// Shared ink/paper colours used across the hatch, outline and grid shaders so a single toggle
// recolours the whole scene live. Two themes: classic paper (ink on cream) and blueprint
// (white on blue). Values are the shader's working colours; `bg` is the matching CSS/scene colour.
import * as THREE from 'three';
import { uniform } from 'three/tsl';

export const inkColor = uniform(new THREE.Vector3(0.078, 0.067, 0.043));
export const paperColor = uniform(new THREE.Vector3(0.949, 0.914, 0.816));

const THEMES = {
  paper: { ink: [0.078, 0.067, 0.043], paper: [0.949, 0.914, 0.816], bg: '#f2e9d0' },
  blueprint: { ink: [0.58, 0.71, 0.92], paper: [0.05, 0.19, 0.42], bg: '#0f3b74' },
};

let current = 'paper';

export function applyTheme(name, scene) {
  const t = THEMES[name] || THEMES.paper;
  current = t === THEMES.paper ? 'paper' : name;
  inkColor.value.set(...t.ink);
  paperColor.value.set(...t.paper);
  if (scene) {
    if (!scene.background) scene.background = new THREE.Color();
    scene.background.set(t.bg);
  }
  document.documentElement.dataset.theme = current;
}

export function toggleTheme(scene) {
  applyTheme(current === 'paper' ? 'blueprint' : 'paper', scene);
  return current;
}

export const currentTheme = () => current;
