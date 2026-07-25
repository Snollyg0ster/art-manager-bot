import { InlineKeyboard, type Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { channels } from '../../db/schema.js';
import { matchQueue, triageQueue } from '../../queue.js';
import { fetchChannelOwner } from '../../services/channels.js';
import { appendEvent, classify, projectMembership, upsertUser } from '../../services/events.js';

export function registerChatMember(bot: Bot): void {
  /** RFC §8.2 — главный рабочий цикл. */
  bot.on('chat_member', async (ctx) => {
    const { chat, old_chat_member: o, new_chat_member: n } = ctx.chatMember;
    const type = classify(o, n);
    if (!type) return;

    await upsertUser(n.user); // username и имя фиксируем всегда

    const event = await appendEvent({
      chatId: chat.id,
      userId: n.user.id,
      event: type,
      at: new Date(ctx.chatMember.date * 1000),
      atPrecision: 'exact',
      observedVia: 'chat_member',
      updateId: ctx.update.update_id,
    });
    if (!event) return; // ретрай вебхука, всё уже обработано

    await projectMembership(chat.id, n.user.id);

    if (type === 'join' || type === 'unban') {
      // RFC §8.4: возможно, это контрагент из журнала подписался в ответ.
      // Разбирается воркером — здесь не место для запросов в Telegram.
      await matchQueue.add(
        'match-join',
        { chatId: chat.id, userId: n.user.id },
        { removeOnComplete: true, removeOnFail: 100 },
      );
      return;
    }

    // Возврат в пределах grace гасит триаж уже в воркере, по логу (RFC §8.2).
    await triageQueue.add(
      'triage-leave',
      { chatId: chat.id, userId: n.user.id, eventId: event.id },
      { delay: config.graceMs, removeOnComplete: true, removeOnFail: 100 },
    );
  });

  /** Онбординг из RFC §14: бота сделали админом канала. */
  bot.on('my_chat_member', async (ctx) => {
    const { chat, new_chat_member: n } = ctx.myChatMember;
    if (chat.type !== 'channel') return;

    if (n.status !== 'administrator') {
      await db.update(channels)
        .set({ botIsAdmin: false })
        .where(eq(channels.chatId, chat.id));
      return;
    }

    // Владелец канала — creator, а не тот, кто добавил бота. Внутри повторы:
    // в момент этого апдейта права бота Telegram ещё не показывает, а второго
    // my_chat_member не будет. Ценой этого — пауза до ~4 с на онбординге.
    const ownerUserId = await fetchChannelOwner(ctx.api, chat.id);

    await db
      .insert(channels)
      .values({
        chatId: chat.id,
        username: chat.username ?? null,
        title: chat.title ?? null,
        ownerUserId,
        botIsAdmin: true,
      })
      .onConflictDoUpdate({
        target: channels.chatId,
        set: {
          username: chat.username ?? null,
          title: chat.title ?? null,
          ownerUserId,
          botIsAdmin: true,
        },
      });

    if (!ownerUserId) return;

    // RFC §15: ожидание выставляется честно на старте.
    await ctx.api.sendMessage(ownerUserId, [
      `Готово, слежу за «${chat.title ?? 'каналом'}».`,
      '',
      'Важно: уходы я вижу начиная с этой минуты. Кто отписался раньше — не узнаю,',
      'такого метода в Telegram нет.',
      '',
      'Остался один шаг — загрузить список каналов, на которые подписан ты.',
      'Без него я не смогу отличить уход из мью от ухода случайного подписчика.',
    ].join('\n'), {
      reply_markup: new InlineKeyboard()
        .text('📥 Загрузить подписки', 'm:import').row()
        .text('‹ Меню', 'm:menu'),
    }).catch(() => {});
  });
}
