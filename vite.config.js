import { defineConfig } from 'vite';

// On GitHub Pages a project site is served from https://<user>.github.io/<repo>/, so assets
// must be requested from '/<repo>/'. Derive that from GITHUB_REPOSITORY in CI; use '/' locally.
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];

export default defineConfig({
  root: '.',
  base: repo ? `/${repo}/` : '/',
  server: { open: true },
  build: { target: 'esnext' },
});
