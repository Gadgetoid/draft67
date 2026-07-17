// Save/load voxel models: JSON file download/upload + localStorage autosave.
const LS_KEY = 'draft-voxel-autosave';

export function autosave(world) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(world.toJSON())); } catch { /* quota */ }
}

export function restore(world) {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    const blocks = Array.isArray(data) ? data : data?.blocks;
    if (Array.isArray(blocks) && blocks.length) { world.fromJSON(data); return true; }
  } catch { /* corrupt */ }
  return false;
}

export function downloadJSON(world) {
  const blob = new Blob([JSON.stringify(world.toJSON())], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `draft-${world.size}blocks.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function loadFile(world, file, done) {
  const r = new FileReader();
  r.onload = () => {
    try { world.fromJSON(JSON.parse(r.result)); done?.(true); }
    catch { done?.(false); }
  };
  r.readAsText(file);
}
