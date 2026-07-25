import { InlineKeyboard, type Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { channels, triageItems } from '../../db/schema.js';
import {
  addUnresolvedPair, bindAndBreak, dropSub, mutualSubByChat,
} from '../../services/pairs.js';
import {
  parseExport, parseHandleList, saveImported, normalizeChannelId,
} from '../../services/import.js';
import { awaitingChannelItem, setAwaitingChannel } from '../../services/triage.js';
import { upsertUser } from '../../services/events.js';
import {
  helpScreen, importScreen, labelScreen, mainMenu, mutualsScreen, newSubsScreen,
  reportScreen, startScreen, triageScreen, type Screen,
} from '../screens.js';

/** Команды дублируют кнопки: то же действие, тот же экран. */
export const COMMANDS = [
  { command: 'start', description: 'меню и как начать' },
  { command: 'report', description: 'отчёт: кто ушёл, кто подписался' },
  { command: 'triage', description: 'разобрать уходы' },
  { command: 'new', description: 'новые подписчики' },
  { command: 'label', description: 'разметить подписки' },
  { command: 'unsub', description: 'я отписался: список или /unsub @channel' },
  { command: 'import', description: 'загрузить список подписок' },
  { command: 'add', description: 'добавить мью вручную: /add @channel' },
  { command: 'help', description: 'как это работает' },
  { command: 'delete_me', description: 'удалить все мои данные' },
];

export function registerCommands(bot: Bot): void {
  bot.command('start', async (ctx) => {
    await upsertUser(ctx.from!);
    await send(ctx, startScreen());
  });

  bot.command('help', async (ctx) => {
    await send(ctx, helpScreen());
  });

  bot.command('report', async (ctx) => {
    await send(ctx, await reportScreen(ctx.api, ctx.from!.id));
  });

  bot.command('import', async (ctx) => {
    await send(ctx, importScreen());
  });

  bot.command('label', async (ctx) => {
    await send(ctx, await labelScreen(ctx.from!.id));
  });

  bot.command('triage', async (ctx) => {
    await send(ctx, await triageScreen(ctx.from!.id));
  });

  bot.command('new', async (ctx) => {
    await send(ctx, await newSubsScreen(ctx.api, ctx.from!.id));
  });

  bot.command('unsub', async (ctx) => {
    const arg = ctx.match?.toString().trim();
    if (!arg) return void send(ctx, await mutualsScreen(ctx.from!.id));

    // Быстрый путь при длинном журнале: канал называют, а не ищут кнопкой.
    const handle = arg.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
    try {
      const chat = await ctx.api.getChat(`@${handle}`);
      const sub = await mutualSubByChat(ctx.from!.id, chat.id);
      if (!sub) {
        return void ctx.reply(
          `@${handle} среди действующих мью не нашёл. Открой список кнопкой.`,
          { reply_markup: new InlineKeyboard().text('🚪 Я отписался', 'm:mutuals') },
        );
      }

      await dropSub(sub.id, ctx.from!.id);
      await ctx.reply(
        `Записал: ты больше не подписан на @${handle}. Из журнала мью убрал.`,
        { reply_markup: mainMenu() },
      );
    } catch {
      await ctx.reply('Не нашёл такой публичный канал. Приватные — только кнопкой из списка.');
    }
  });

  bot.command('add', async (ctx) => {
    const arg = ctx.match?.toString().trim();
    if (!arg) return void ctx.reply('Формат: /add @channel');
    const handle = arg.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');

    try {
      const chat = await ctx.api.getChat(`@${handle}`);
      if (chat.type !== 'channel') return void ctx.reply('Это не канал.');

      await db.insert(channels).values({
        chatId: chat.id,
        username: chat.username ?? null,
        title: chat.title ?? null,
      }).onConflictDoUpdate({
        target: channels.chatId,
        set: { username: chat.username ?? null, title: chat.title ?? null },
      });

      await addUnresolvedPair(ctx.from!.id, chat.id);
      await ctx.reply(
        `Записал мью с @${handle}.\n` +
        'Кто им владеет — выяснится, когда этот человек что-нибудь сделает в твоём канале.',
        { reply_markup: mainMenu() },
      );
    } catch {
      await ctx.reply('Не нашёл такой публичный канал. Приватные так добавить нельзя.');
    }
  });

  bot.command('delete_me', async (ctx) => {
    const kb = new InlineKeyboard()
      .text('Да, удалить всё', 'wipe:yes').row()
      .text('‹ Меню', 'm:menu');
    await ctx.reply(
      'Удалю канал, журнал мью и весь лог событий по твоему каналу. Это необратимо.',
      { reply_markup: kb },
    );
  });

  // Загрузка экспорта файлом
  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    if (!doc.file_name?.endsWith('.json')) {
      return void ctx.reply('Жду result.json из экспорта Telegram Desktop.');
    }
    if ((doc.file_size ?? 0) > config.maxExportBytes) {
      return void ctx.reply(
        'Файл слишком большой. Перезалей экспорт, ограничив его каналами, ' +
        'или пришли список @handle текстом.',
      );
    }

    await ctx.reply('Разбираю…');
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
      const json = await fetch(url).then((r) => r.json());
      const items = parseExport(json);
      const saved = await saveImported(ctx.from!.id, items, 'export');
      await ctx.reply(
        `Нашёл каналов: ${items.length}, новых записал: ${saved}.`,
        { reply_markup: new InlineKeyboard().text('🏷 Разметить', 'm:label') },
      );
    } catch (e) {
      console.error('export import failed', e);
      await ctx.reply('Не смог разобрать файл. Пришли список @handle текстом.');
    }
  });

  // Текст: либо ответ на «пришли @handle» из триажа, либо список подписок
  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    const ownerId = ctx.from!.id;

    const pending = await awaitingChannelItem(ownerId);
    if (pending) {
      const [handle] = parseHandleList(ctx.message.text);
      if (!handle) return void ctx.reply('Не понял. Пришли @handle канала.');

      try {
        const chat = await ctx.api.getChat(`@${handle}`);
        if (chat.type !== 'channel') return void ctx.reply('Это не канал.');

        await db.insert(channels).values({
          chatId: chat.id, username: chat.username ?? null, title: chat.title ?? null,
        }).onConflictDoUpdate({
          target: channels.chatId,
          set: { username: chat.username ?? null, title: chat.title ?? null },
        });

        await bindAndBreak({
          ownerUserId: ownerId,
          counterpartUserId: pending.payload.userId,
          counterpartChatId: chat.id,
        });
        await setAwaitingChannel(pending.id, false);
        await db.update(triageItems).set({ state: 'resolved' })
          .where(eq(triageItems.id, pending.id));

        await ctx.reply(
          `Записал. @${handle} — в списке на отписку, отчёт покажет.\n` +
          'Отписаться нужно руками: бот этого не умеет и уметь не может.',
          { reply_markup: new InlineKeyboard().text('📊 Отчёт', 'm:report') },
        );
      } catch {
        await ctx.reply('Не нашёл такой публичный канал.');
      }
      return;
    }

    const handles = parseHandleList(ctx.message.text);
    if (handles.length === 0) {
      return void ctx.reply('Не понял. Открой меню — там всё кнопками.', {
        reply_markup: mainMenu(),
      });
    }

    let ok = 0;
    for (const h of handles.slice(0, 50)) {
      try {
        const chat = await ctx.api.getChat(`@${h}`);
        if (chat.type !== 'channel') continue;
        await saveImported(ownerId, [{
          chatId: normalizeChannelId(chat.id),
          username: chat.username ?? null,
          title: chat.title ?? h,
        }], 'manual');
        ok += 1;
      } catch { /* пропускаем нерезолвящиеся */ }
    }
    await ctx.reply(`Записал подписок: ${ok} из ${handles.length}.`, {
      reply_markup: new InlineKeyboard().text('🏷 Разметить', 'm:label'),
    });
  });
}

type Replier = { reply: (text: string, other?: { reply_markup: InlineKeyboard }) => Promise<unknown> };

export async function send(ctx: Replier, screen: Screen): Promise<void> {
  await ctx.reply(screen.text, { reply_markup: screen.keyboard });
}
