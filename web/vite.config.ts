/// <reference types="vitest/config" />
import { defineConfig, defaultClientConditions } from 'vite';
import react from '@vitejs/plugin-react';

// `@ccu/source` resolves @ccu/shared to its TypeScript sources, so the dashboard
// never depends on a stale shared/dist build.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    conditions: ['@ccu/source', ...defaultClientConditions],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: { port: 5173 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
  },
});
