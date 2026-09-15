import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const sourceDirectory = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
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
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
