import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';

/** BullMQ требует maxRetriesPerRequest: null для блокирующих команд воркера. */
export const connection = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

export type TriageLeaveJob = {
  chatId: number;
  userId: number;
  /** id события ухода в membership_events — по нему воркер ищет возврат (RFC §8.2). */
  eventId: number;
};

/**
 * RFC §8.4: контрагент подставляется в пару при первом его событии. Работа
 * уехала в очередь, потому что на подписке может понадобиться getChat, а join —
 * самое частое событие канала; в хэндлере это упиралось бы в флуд-контроль §5.3.
 */
export type MatchJoinJob = {
  chatId: number;
  userId: number;
};

export const triageQueue = new Queue<TriageLeaveJob>('triage', { connection });
export const matchQueue = new Queue<MatchJoinJob>('match', { connection });
export const reconcileQueue = new Queue('reconcile', { connection });

/**
 * RFC §10. Планировщик идемпотентен: повторный вызов с тем же id
 * не плодит расписания, поэтому его безопасно дёргать на каждом старте.
 */
export async function ensureReconcileSchedule(): Promise<void> {
  await reconcileQueue.upsertJobScheduler(
    'reconcile-daily',
    { pattern: config.reconcileCron },
    { name: 'reconcile' },
  );
}

export async function closeQueues(): Promise<void> {
  await triageQueue.close();
  await matchQueue.close();
  await reconcileQueue.close();
  connection.disconnect();
}
