import 'dotenv/config';
import type { Update } from 'grammy/types';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} не задан — см. .env.example`);
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} должен быть числом, получено «${raw}»`);
  return v;
}

/**
 * RFC §5.3: chat_member НЕ приходит без явного allowed_updates —
 * ни в long polling, ни в вебхуке. Список один на оба транспорта.
 */
export const ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'chat_member',
  'my_chat_member',
] satisfies ReadonlyArray<Exclude<keyof Update, 'update_id'>>;

export const config = {
  botToken: required('BOT_TOKEN'),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',

  /** RFC §8.2: 15 минут на случайный выход-возврат. */
  graceMs: num('GRACE_MS', 15 * 60 * 1000),

  /** RFC §11: лимит на result.json вместо стримового парсера. */
  maxExportBytes: num('MAX_EXPORT_BYTES', 20 * 1024 * 1024),

  /** RFC §10: ежесуточная сверка. */
  reconcileCron: process.env.RECONCILE_CRON ?? '0 4 * * *',
};
