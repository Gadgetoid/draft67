// Export the current outlined view as a 1-bit blueprint PNG (WYSIWYG through the outline pipeline).
import * as THREE from 'three';

// size must be a multiple of 64 so each row (size*4 bytes) is 256-byte aligned; otherwise
// WebGPU pads the readback row stride and the image shears.
export async function exportBlueprint(renderer, scene, outline, camera, { height = 1536 } = {}) {
  // Match the export aspect to the camera so it isn't stretched. Width must be a multiple of 64
  // (256-byte row alignment) or the WebGPU readback shears.
  const aspect = camera.isOrthographicCamera
    ? (camera.right - camera.left) / (camera.top - camera.bottom)
    : (camera.aspect || 1);
  const h = Math.max(64, Math.round(height / 64) * 64);
  const w = Math.max(64, Math.round((h * aspect) / 64) * 64);

  let rt;
  if (outline) {
    rt = await outline.renderToRT(scene, camera, w, h);
  } else {
    rt = new THREE.RenderTarget(w, h);
    renderer.setRenderTarget(rt);
    await renderer.renderAsync(scene, camera);
    renderer.setRenderTarget(null);
  }

  const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h);
  rt.dispose();

  // flip Y into a 2D canvas
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * row;
    img.data.set(buf.subarray(src, src + row), y * row);
  }
  ctx.putImageData(img, 0, 0);

  await new Promise((resolve) => cv.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `blueprint-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    resolve();
  }, 'image/png'));
}
