import { bot } from './bot/index.js';
import { COMMANDS } from './bot/handlers/commands.js';
import { ALLOWED_UPDATES } from './config.js';
import { closeQueues, ensureReconcileSchedule } from './queue.js';
import { closeDb } from './db/index.js';

await ensureReconcileSchedule();

/**
 * Меню команд в интерфейсе Telegram: те же действия, что и на кнопках.
 * Без await и с глушением ошибки: украшение не должно ни ронять процесс, ни
 * задерживать long polling — сетевой таймаут здесь делал и то, и другое.
 * В лог только текст: внутри ошибки grammy лежит URL с токеном.
 */
void bot.api.setMyCommands(COMMANDS).catch((e: unknown) => {
  console.error('setMyCommands не прошёл', e instanceof Error ? e.message : e);
});

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
