import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        redirect: resolve(import.meta.dirname, 'redirect.html'),
      },
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});
