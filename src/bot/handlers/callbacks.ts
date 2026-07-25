import { InlineKeyboard, type Bot } from 'grammy';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  channels, membershipEvents, memberships, outboundSubs, pairs, triageItems,
  userChannelLinks, users,
} from '../../db/schema.js';
import { bindAndBreak, closePair, deferSub, dropSub, labelSub } from '../../services/pairs.js';
import {
  acceptJoined, acceptMatch, getJoinedItem, getMatchItem, setJoinedState,
} from '../../services/subscribers.js';
import {
  channelLabel, getTriageItem, setAwaitingChannel, setTriageState,
} from '../../services/triage.js';
import {
  helpScreen, importScreen, labelScreen, mutualsScreen, newSubsScreen, reportScreen,
  startScreen, triageScreen,
} from '../screens.js';
import { send } from './commands.js';

export function registerCallbacks(bot: Bot): void {
  /** Меню. Каждая кнопка ведёт в тот же экран, что и одноимённая команда. */
  bot.callbackQuery(/^m:(menu|import|label|report|triage|new|mutuals|help|wipe)$/, async (ctx) => {
    const screen = ctx.match[1];
    const ownerId = ctx.from.id;
    await ctx.answerCallbackQuery();

    switch (screen) {
      case 'menu':
        return void send(ctx, startScreen());
      case 'help':
        return void send(ctx, helpScreen());
      case 'import':
        return void send(ctx, importScreen());
      case 'label':
        return void send(ctx, await labelScreen(ownerId));
      case 'triage':
        return void send(ctx, await triageScreen(ownerId));
      case 'new':
        return void send(ctx, await newSubsScreen(ctx.api, ownerId));
      case 'mutuals':
        return void send(ctx, await mutualsScreen(ownerId));
      case 'report':
        return void send(ctx, await reportScreen(ctx.api, ownerId));
      case 'wipe':
        return void ctx.reply(
          'Удалю канал, журнал мью и весь лог событий по твоему каналу. Это необратимо.',
          {
            reply_markup: new InlineKeyboard()
              .text('Да, удалить всё', 'wipe:yes').row()
              .text('‹ Меню', 'm:menu'),
          },
        );
    }
  });

  /** RFC §8.4: подтверждение догадки «этот подписавшийся — владелец канала». */
  bot.callbackQuery(/^p:(\d+):(y|n)$/, async (ctx) => {
    const itemId = Number(ctx.match[1]);
    const ownerId = ctx.from.id;

    const item = await getMatchItem(itemId, ownerId);
    if (!item) {
      await ctx.answerCallbackQuery('Вопрос уже снят');
      return;
    }

    await ctx.editMessageReplyMarkup().catch(() => {});

    if (ctx.match[2] === 'y') {
      const channel = await acceptMatch(ownerId, item);
      await ctx.answerCallbackQuery();
      await ctx.reply(
        `Записал: мью с ${channelLabel(channel)} — это он. Слежу за парой.`,
      );
      return;
    }

    // Отказ тоже помним: иначе вопрос вернётся на каждой его переподписке.
    await setJoinedState(ownerId, itemId, 'dismissed');
    await ctx.answerCallbackQuery();
    await ctx.reply('Понял, не он. Больше не спрошу.');
  });

  /** Следующая страница списка мью. */
  bot.callbackQuery(/^mu:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await send(ctx, await mutualsScreen(ctx.from.id, Number(ctx.match[1])));
  });

  /** «Я отписался» вне контекста ухода: журнал мью правит только владелец. */
  bot.callbackQuery(/^u:(\d+)$/, async (ctx) => {
    const subId = Number(ctx.match[1]);
    const ownerId = ctx.from.id;

    const ok = await dropSub(subId, ownerId);
    await ctx.answerCallbackQuery(ok ? 'Записал' : 'Записи уже нет');
    await ctx.editMessageReplyMarkup().catch(() => {});
    await send(ctx, await mutualsScreen(ownerId));
  });

  /** Разбор нового подписчика (§7, kind='joined'). */
  bot.callbackQuery(/^j:(\d+):(y|n|s)$/, async (ctx) => {
    const itemId = Number(ctx.match[1]);
    const answer = ctx.match[2];
    const ownerId = ctx.from.id;

    const item = await getJoinedItem(itemId, ownerId);
    if (!item) {
      await ctx.answerCallbackQuery('Карточки уже нет');
      return;
    }

    await ctx.editMessageReplyMarkup().catch(() => {});

    if (answer === 'y') {
      const hint = await acceptJoined(ownerId, item);
      await ctx.answerCallbackQuery();
      await ctx.reply(
        hint
          ? `Записал мью с ${channelLabel(hint)}. Если он отпишется — сообщу.`
          : 'Канал этого человека мне неизвестен. Пришли «/add @handle».',
      );
    } else if (answer === 'n') {
      await setJoinedState(ownerId, itemId, 'dismissed');
      await ctx.answerCallbackQuery();
      await ctx.reply('Скрыл. Больше про него не спрошу.');
    } else {
      // «Позже»: карточка остаётся открытой и всплывёт в следующий раз.
      await ctx.answerCallbackQuery('Отложил');
    }

    await send(ctx, await newSubsScreen(ctx.api, ownerId));
  });
  /** RFC §9: «Отписался, готово» — пара уходит в closed. */
  bot.callbackQuery(/^d:(\d+)$/, async (ctx) => {
    const pairId = Number(ctx.match[1]);
    const ok = await closePair(pairId, ctx.from.id);
    await ctx.answerCallbackQuery(ok ? 'Закрыто' : 'Уже закрыто');
    await ctx.editMessageReplyMarkup().catch(() => {});
  });

  /** RFC §8.2: разбор карточки ухода. */
  bot.callbackQuery(/^t:(\d+):(y|n|s|h)$/, async (ctx) => {
    const itemId = Number(ctx.match[1]);
    const answer = ctx.match[2];
    const item = await getTriageItem(itemId, ctx.from.id);
    if (!item) {
      await ctx.answerCallbackQuery('Карточки уже нет');
      return;
    }

    await ctx.editMessageReplyMarkup().catch(() => {});

    // §8.3 п.1: владелец подтвердил подставленный канал. Связь становится
    // 'manual' — предположение проверено человеком.
    const hint = item.payload.channelHint;
    if (answer === 'h' && hint) {
      await bindAndBreak({
        ownerUserId: ctx.from.id,
        counterpartUserId: item.payload.userId,
        counterpartChatId: hint.chatId,
      });
      await setTriageState(itemId, ctx.from.id, 'resolved');
      await ctx.answerCallbackQuery();
      await ctx.reply(
        `Записал: ${channelLabel(hint)} — в списке на отписку, /report покажет.\n` +
        'Отписаться нужно руками: бот этого не умеет и уметь не может.',
      );
      return;
    }

    if (answer === 'y' || answer === 'h') {
      // §8.3 п.3: ручной ввод @handle. Сюда же попадает «да, но канал другой»
      // и подтверждение подсказки, которой в карточке почему-то не оказалось.
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
    await send(ctx, await labelScreen(ownerId));
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
