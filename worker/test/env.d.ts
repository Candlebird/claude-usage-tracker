/// <reference types="@cloudflare/vitest-plugin/types" />
import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../src/db.js';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import('../src/index.js');
    }
  }
}
