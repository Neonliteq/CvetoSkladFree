import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Where the dev server proxies `/api`. The API server runs on port 5000 by default.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:5000';

// Served from the root by default: a fresh install has no reverse proxy in front,
// so requiring the variable would only add a step that must be explained.
const basePath = process.env.BASE_PATH ?? '/';
const port = Number(process.env.PORT ?? 5173);

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  server: {
    port,
    host: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(import.meta.dirname, '..', '..', 'attached_assets'),
    },
  },
  build: { outDir: path.resolve(import.meta.dirname, 'dist/public'), emptyOutDir: true },
});
