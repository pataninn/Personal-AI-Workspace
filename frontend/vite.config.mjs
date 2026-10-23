// @ts-check
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { previewPlugin } from './preview/preview-plugin.mjs';

const sourceDirectory = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig(({ mode }) => ({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': sourceDirectory
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173
  },
  preview: {
    host: '127.0.0.1',
    port: 5173
  },
  plugins: [tailwindcss(), ...(mode === 'preview' ? [previewPlugin()] : [])],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
}));
