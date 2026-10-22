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
    // Pages are lazy-loaded (App.tsx); Recharts and its d3/redux dependencies get their own
    // chunk so the first paint only needs React and the shell. Keeps every chunk under 500 kB.
    chunkSizeWarningLimit: 500,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'recharts', test: /[\\/]node_modules[\\/]recharts[\\/]/, priority: 20 },
            {
              name: 'chart-deps',
              test: /[\\/]node_modules[\\/](d3-[^\\/]+|victory-vendor|internmap|@reduxjs|redux|redux-thunk|react-redux|use-sync-external-store|immer|reselect|es-toolkit|decimal\.js-light|eventemitter3|tiny-invariant)[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  server: { port: 5173 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
  },
});
