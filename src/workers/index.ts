import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { bot } from '../bot/index.js';
import { connection, type TriageLeaveJob } from '../queue.js';
import { db } from '../db/index.js';
import { channels, pairs } from '../db/schema.js';
import { appendEvent, hasReturnedSince, projectMembership, isMember } from '../services/events.js';
import { findPairByCounterpartUser, ownerOfChannel, setPairState } from '../services/pairs.js';
import { createLeaveTriage, renderTriageCard } from '../services/triage.js';
import { InlineKeyboard } from 'grammy';

/**
 * RFC §8.2: воркер не дёргает getChatMember, а смотрит в лог —
 * было ли после ухода событие возврата. Убирает гонку между
 * вебхуком и опросом.
 */
const triageWorker = new Worker<TriageLeaveJob>(
  'triage',
  async (job) => {
    const { chatId, userId, eventId } = job.data;

    const ownerUserId = await ownerOfChannel(chatId);
    if (!ownerUserId) return;

    if (await hasReturnedSince(chatId, userId, eventId)) {
      const pair = await findPairByCounterpartUser(ownerUserId, userId);
      if (pair && pair.state === 'broken') await setPairState(pair.id, 'returned');
      return;
    }

    const pair = await findPairByCounterpartUser(ownerUserId, userId);

    if (pair) {
      await setPairState(pair.id, 'broken');
      const [ch] = await db
        .select({ username: channels.username, title: channels.title })
        .from(channels)
        .where(eq(channels.chatId, pair.counterpartChatId))
        .limit(1);
      const handle = ch?.username ? `@${ch.username}` : (ch?.title ?? 'канал');
      const kb = new InlineKeyboard().text('Отписался, готово', `d:${pair.id}`);
      await bot.api.sendMessage(
        ownerUserId,
        `❌ ${handle} — контрагент отписался от тебя.\nТы всё ещё подписан.`,
        { reply_markup: kb },
      ).catch(() => {});
      return;
    }

    const created = await createLeaveTriage({
      ownerUserId, chatId, userId,
      leftAt: new Date(),
      leftAtPrecision: 'exact',
    });
    if (!created) return;

    const kb = new InlineKeyboard()
      .text('Да, мью', `t:${created.id}:y`)
      .text('Нет', `t:${created.id}:n`)
      .text('Не помню', `t:${created.id}:s`);
    await bot.api.sendMessage(ownerUserId, renderTriageCard(created.payload), {
      reply_markup: kb,
    }).catch(() => {});
  },
  { connection, concurrency: 4 },
);

/**
 * RFC §10. Расхождение пишется как событие с at_precision='window':
 * мы знаем, что уход был между сверками, но не знаем когда.
 */
const reconcileWorker = new Worker(
  'reconcile',
  async () => {
    const watching = await db
      .select()
      .from(pairs)
      .where(eq(pairs.state, 'watching'));

    for (const pair of watching) {
      if (!pair.counterpartUserId) continue;

      const own = await db
        .select({ chatId: channels.chatId })
        .from(channels)
        .where(eq(channels.ownerUserId, pair.ownerUserId))
        .limit(1);
      const ownChatId = own[0]?.chatId;
      if (!ownChatId) continue;

      try {
        const member = await bot.api.getChatMember(ownChatId, pair.counterpartUserId);
        if (isMember(member)) continue;

        const event = await appendEvent({
          chatId: ownChatId,
          userId: pair.counterpartUserId,
          event: member.status === 'kicked' ? 'kick' : 'leave',
          at: new Date(),
          atPrecision: 'window',
          observedVia: 'reconcile',
        });
        if (event) {
          await projectMembership(ownChatId, pair.counterpartUserId);
          await setPairState(pair.id, 'broken');
        }
      } catch (e) {
        console.error('reconcile failed', pair.id, e);
      }

      await sleep(250); // флуд-контроль, RFC §5.3
    }
  },
  { connection },
);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

for (const w of [triageWorker, reconcileWorker]) {
  w.on('failed', (job, err) => console.error('job failed', job?.id, err));
}

console.log('workers up');
