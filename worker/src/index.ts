import { runAlerts } from './alerts.js';
import type { Env } from './db.js';
import { prune, shouldPrune } from './prune.js';
import { createRouter } from './router.js';
import { ROUTES } from './routes.js';
import { errText } from './routes/ingest.js';

export type { Env } from './db.js';

const router = createRouter(ROUTES);

async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  const now = Math.floor(controller.scheduledTime / 1000);
  try {
    await runAlerts(env, now);
  } catch (e) {
    console.error('alerts failed', errText(e));
  }
  if (shouldPrune(now)) {
    try {
      await prune(env, now);
    } catch (e) {
      console.error('prune failed', errText(e));
    }
  }
}

export default {
  fetch: router,
  scheduled,
} satisfies ExportedHandler<Env>;
