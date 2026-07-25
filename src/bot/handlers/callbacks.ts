import type { Bot } from 'grammy';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  channels, membershipEvents, memberships, outboundSubs, pairs, triageItems,
  userChannelLinks, users,
} from '../../db/schema.js';
import { closePair, deferSub, labelSub } from '../../services/pairs.js';
import { getTriageItem, setAwaitingChannel, setTriageState } from '../../services/triage.js';
import { sendNextLabel } from './commands.js';

export function registerCallbacks(bot: Bot): void {
  /** RFC §9: «Отписался, готово» — пара уходит в closed. */
  bot.callbackQuery(/^d:(\d+)$/, async (ctx) => {
    const pairId = Number(ctx.match[1]);
    const ok = await closePair(pairId, ctx.from.id);
    await ctx.answerCallbackQuery(ok ? 'Закрыто' : 'Уже закрыто');
    await ctx.editMessageReplyMarkup().catch(() => {});
  });

  /** RFC §8.2: разбор карточки ухода. */
  bot.callbackQuery(/^t:(\d+):(y|n|s)$/, async (ctx) => {
    const itemId = Number(ctx.match[1]);
    const answer = ctx.match[2];
    const item = await getTriageItem(itemId, ctx.from.id);
    if (!item) {
      await ctx.answerCallbackQuery('Карточки уже нет');
      return;
    }

    await ctx.editMessageReplyMarkup().catch(() => {});

    if (answer === 'y') {
      // §8.3 п.3: единственный надёжный путь — ручной ввод @handle.
      // Автоподстановка канала появится, когда подтвердится §5.2.
      await setAwaitingChannel(itemId, true);
      await ctx.answerCallbackQuery();
      await ctx.reply('Пришли @handle его канала — проверю и запишу в список на отписку.');
      return;
    }

    await setTriageState(itemId, ctx.from.id, 'dismissed');
    await ctx.answerCallbackQuery();
    await ctx.reply(
      answer === 'n'
        ? 'Ок, записал: это не мью. Больше не спрошу.'
        : 'Убрал из очереди. Захочешь вернуться — /add @channel.',
    );
  });

  /** RFC §8.1: разметка подписок пачкой. */
  bot.callbackQuery(/^l:(\d+):(m|n|s)$/, async (ctx) => {
    const subId = Number(ctx.match[1]);
    const answer = ctx.match[2];
    const ownerId = ctx.from.id;

    if (answer === 's') await deferSub(subId, ownerId);
    else await labelSub(subId, ownerId, answer === 'm' ? 'mutual' : 'not_mutual');

    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    await sendNextLabel(ownerId, (text, kb) => ctx.reply(text, { reply_markup: kb }));
  });

  /**
   * RFC §13. Append-only относится к нормальной работе, а не к удалению
   * по запросу: строки стираются физически, включая лог по каналу владельца.
   */
  bot.callbackQuery('wipe:yes', async (ctx) => {
    const ownerId = ctx.from.id;
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});

    await db.transaction(async (tx) => {
      const own = await tx
        .select({ chatId: channels.chatId })
        .from(channels)
        .where(eq(channels.ownerUserId, ownerId));
      const ownChatIds = own.map((c) => c.chatId);

      const journal = await tx
        .select({ chatId: pairs.counterpartChatId })
        .from(pairs)
        .where(eq(pairs.ownerUserId, ownerId));
      const journalChatIds = journal.map((p) => p.chatId);

      if (ownChatIds.length > 0) {
        await tx.delete(membershipEvents).where(inArray(membershipEvents.chatId, ownChatIds));
        await tx.delete(memberships).where(inArray(memberships.chatId, ownChatIds));
        await tx.delete(channels).where(inArray(channels.chatId, ownChatIds));
      }
      if (journalChatIds.length > 0) {
        await tx.delete(userChannelLinks).where(inArray(userChannelLinks.chatId, journalChatIds));
      }

      await tx.delete(triageItems).where(eq(triageItems.ownerUserId, ownerId));
      await tx.delete(pairs).where(eq(pairs.ownerUserId, ownerId));
      await tx.delete(outboundSubs).where(eq(outboundSubs.ownerUserId, ownerId));
      await tx.delete(users).where(eq(users.tgUserId, ownerId));
    });

    await ctx.reply('Удалил всё: канал, журнал и лог событий. Если вернёшься — /start.');
  });

  bot.on('callback_query:data', async (ctx) => {
    console.warn('неизвестный callback', ctx.callbackQuery.data);
    await ctx.answerCallbackQuery();
  });
}
