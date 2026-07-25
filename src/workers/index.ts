import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { bot } from '../bot/index.js';
import { connection, type MatchJoinJob, type TriageLeaveJob } from '../queue.js';
import { db } from '../db/index.js';
import { channels, pairs } from '../db/schema.js';
import {
  ensureChannelOwner, personalChannelOf, saveChannelHint,
} from '../services/channels.js';
import {
  appendEvent, eventTime, hasReturnedSince, projectMembership, isMember,
} from '../services/events.js';
import { findPairByCounterpartUser, setPairState } from '../services/pairs.js';
import {
  matchKeyboard, renderMatchCard, resolveCounterpartOnJoin,
} from '../services/subscribers.js';
import {
  channelLabel, createLeaveTriage, renderTriageCard, triageKeyboard,
} from '../services/triage.js';
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

    // Не ownerOfChannel: если онбординг §14 не достал creator, владельца надо
    // добрать здесь, иначе разбор уходов по этому каналу не заработает никогда.
    const ownerUserId = await ensureChannelOwner(bot.api, chatId);
    if (!ownerUserId) return;

    if (await hasReturnedSince(chatId, userId, eventId)) {
      const pair = await findPairByCounterpartUser(ownerUserId, userId);
      if (pair && pair.state === 'broken') await setPairState(pair.id, 'returned');
      return;
    }

    const pair = await findPairByCounterpartUser(ownerUserId, userId);

    // Владелец отписался сам — вопрос закрыт. Воскрешать пару нельзя: бот
    // написал бы «ты всё ещё подписан», хотя это уже неправда.
    if (pair?.state === 'closed') return;

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

    // RFC §8.3 п.1: подсказка канала. Уходит в карточку как предположение,
    // связь пишется с confidence='personal' — действовать по ней нельзя.
    const hint = await personalChannelOf(bot.api, userId);
    if (hint) await saveChannelHint(userId, hint);

    // RFC §10: время ухода — из лога. Здесь мы минимум на grace позже события,
    // поэтому new Date() с пометкой 'exact' был бы прямой ложью в карточке.
    const leave = await eventTime(eventId);

    const created = await createLeaveTriage({
      ownerUserId, chatId, userId,
      leftAt: leave?.at ?? new Date(),
      leftAtPrecision: leave?.atPrecision ?? 'window',
      channelHint: hint ?? undefined,
    });
    if (!created) return;

    await bot.api.sendMessage(ownerUserId, renderTriageCard(created.payload), {
      reply_markup: triageKeyboard(created),
    }).catch(() => {});
  },
  { connection, concurrency: 4 },
);

/**
 * RFC §8.4. Подписался человек — не тот ли это контрагент, чей канал уже лежит
 * в журнале мью без user_id. Отдельный воркер, потому что здесь возможен
 * getChat, а join — самое частое событие канала.
 */
const matchWorker = new Worker<MatchJoinJob>(
  'match',
  async (job) => {
    const { chatId, userId } = job.data;

    const ownerUserId = await ensureChannelOwner(bot.api, chatId);
    if (!ownerUserId) return;

    const outcome = await resolveCounterpartOnJoin(bot.api, ownerUserId, chatId, userId);
    if (outcome.kind === 'none') return;

    if (outcome.kind === 'linked') {
      await bot.api.sendMessage(
        ownerUserId,
        `🔗 ${outcome.who} подписался в ответ — мью с ${channelLabel(outcome.channel)} `
        + 'теперь под наблюдением. Если уйдёт, скажу.',
      ).catch(() => {});
      return;
    }

    await bot.api.sendMessage(ownerUserId, renderMatchCard(outcome.ask), {
      reply_markup: matchKeyboard(outcome.ask.itemId),
    }).catch(() => {});
  },
  { connection, concurrency: 2 },
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

for (const w of [triageWorker, matchWorker, reconcileWorker]) {
  w.on('failed', (job, err) => console.error('job failed', job?.id, err));
}

console.log('workers up');
