import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo>/; override with VITE_BASE when hosting elsewhere.
export default defineConfig({
  base: process.env.VITE_BASE ?? './',
  build: { target: 'es2022', chunkSizeWarningLimit: 800 },
});
