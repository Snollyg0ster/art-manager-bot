import { bot } from './bot/index.js';
import { ALLOWED_UPDATES } from './config.js';
import { closeQueues, ensureReconcileSchedule } from './queue.js';
import { closeDb } from './db/index.js';

await ensureReconcileSchedule();

const stop = async (signal: string) => {
  console.log(`${signal}: останавливаюсь`);
  await bot.stop();
  await closeQueues();
  await closeDb();
  process.exit(0);
};
process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

/**
 * Осознанное отступление от RFC §11: long polling вместо вебхука.
 * allowed_updates работает и здесь, а публичный URL для MVP не нужен.
 * Переезд на вебхук — один setWebhook с тем же ALLOWED_UPDATES.
 */
await bot.start({
  allowed_updates: ALLOWED_UPDATES,
  onStart: (me) => console.log(`bot up: @${me.username}`),
});
