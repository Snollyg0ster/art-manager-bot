import { InlineKeyboard, type Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { channels, triageItems } from '../../db/schema.js';
import { buildReport, renderReport } from '../../services/report.js';
import { nextUnlabeled, addUnresolvedPair, bindAndBreak } from '../../services/pairs.js';
import {
  parseExport, parseHandleList, saveImported, normalizeChannelId,
} from '../../services/import.js';
import {
  awaitingChannelItem, openTriageItems, renderTriageCard, setAwaitingChannel,
} from '../../services/triage.js';
import { upsertUser } from '../../services/events.js';

export function registerCommands(bot: Bot): void {
  bot.command('start', async (ctx) => {
    await upsertUser(ctx.from!);
    await ctx.reply([
      'Веду учёт взаимных подписок.',
      '',
      'Чтобы начать: добавь меня администратором в свой канал.',
      'Права можно не выдавать никакие — мне нужен только доступ к событиям.',
      '',
      'Что я умею:',
      '/import — загрузить список твоих подписок',
      '/label — разметить их (мью / не мью)',
      '/add @channel — добавить мью вручную',
      '/triage — разобрать уходы',
      '/report — отчёт',
      '/delete_me — удалить все мои данные о тебе',
    ].join('\n'));
  });

  bot.command('report', async (ctx) => {
    const report = await buildReport(ctx.from!.id);
    await ctx.reply(renderReport(report));
  });

  bot.command('import', async (ctx) => {
    await ctx.reply([
      'Два пути.',
      '',
      '1. Быстрый: пришли список каналов текстом, по одному в строке.',
      '   Можно @handle или ссылки t.me.',
      '',
      '2. Полный: Telegram Desktop → Settings → Advanced → Export Telegram data.',
      '   Выбери только Public channels и Private channels, формат JSON,',
      '   размер медиа выстави в минимум. Пришли мне result.json файлом.',
      '',
      `Лимит на файл: ${Math.round(config.maxExportBytes / 1024 / 1024)} МБ.`,
    ].join('\n'));
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
      );
    } catch {
      await ctx.reply('Не нашёл такой публичный канал. Приватные так добавить нельзя.');
    }
  });

  bot.command('label', async (ctx) => {
    await sendNextLabel(ctx.from!.id, (text, kb) => ctx.reply(text, { reply_markup: kb }));
  });

  bot.command('triage', async (ctx) => {
    const items = await openTriageItems(ctx.from!.id);
    const item = items.find((i) => !i.payload.awaitingChannel);
    if (!item) return void ctx.reply('Разбирать нечего.');

    const kb = new InlineKeyboard()
      .text('Да, мью', `t:${item.id}:y`)
      .text('Нет', `t:${item.id}:n`)
      .text('Не помню', `t:${item.id}:s`);
    await ctx.reply(renderTriageCard(item.payload), { reply_markup: kb });
  });

  bot.command('delete_me', async (ctx) => {
    const kb = new InlineKeyboard().text('Да, удалить всё', 'wipe:yes');
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
        `Нашёл каналов: ${items.length}, новых записал: ${saved}.\n` +
        'Теперь /label — разметить, где у тебя мью.',
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
          `Записал. @${handle} — в списке на отписку, /report покажет.\n` +
          'Отписаться нужно руками: бот этого не умеет и уметь не может.',
        );
      } catch {
        await ctx.reply('Не нашёл такой публичный канал.');
      }
      return;
    }

    const handles = parseHandleList(ctx.message.text);
    if (handles.length === 0) return;

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
    await ctx.reply(`Записал подписок: ${ok} из ${handles.length}.\nДальше /label.`);
  });
}

export async function sendNextLabel(
  ownerUserId: number,
  send: (text: string, kb: InlineKeyboard) => Promise<unknown>,
): Promise<void> {
  const next = await nextUnlabeled(ownerUserId);
  if (!next) {
    await send('Всё размечено.', new InlineKeyboard());
    return;
  }
  const handle = next.username ? `@${next.username}` : (next.title ?? `id${next.chatId}`);
  const kb = new InlineKeyboard()
    .text('Мью', `l:${next.id}:m`)
    .text('Не мью', `l:${next.id}:n`)
    .text('Пропустить', `l:${next.id}:s`);
  await send(`${handle}\nЭто взаимная подписка?`, kb);
}
