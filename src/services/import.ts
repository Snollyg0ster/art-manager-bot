import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channels, outboundSubs } from '../db/schema.js';

export type ImportedChannel = {
  chatId: number;
  username: string | null;
  title: string | null;
};

/**
 * ⚠️ RFC §8.1, непроверенное место. Схема result.json и формат id взяты
 * по документации и памяти, на реальном экспорте НЕ сверялись. Проверить
 * до продакшена: (1) действительно ли id каналов идут без префикса -100,
 * (2) не переехал ли список из chats.list, (3) есть ли поле username.
 *
 * Парсим через JSON.parse с лимитом размера (config.maxExportBytes), а не
 * стримом: стримовый парсер нужен, когда появятся файлы на сотни мегабайт.
 */
const CHANNEL_TYPES = new Set(['public_channel', 'private_channel']);

/**
 * В экспорте id канала — внутренний, без префикса `-100`, которым его
 * снабжает Bot API. Склейка строкой, а не арифметикой: длина внутреннего
 * id плавает, и `-1e12 - id` даёт неверный результат на девятизначных.
 */
export function normalizeChannelId(id: number | string): number {
  const n = typeof id === 'string' ? Number(id.replace(/^-100/, '')) : id;
  if (!Number.isFinite(n)) throw new Error(`не похоже на chat_id: ${id}`);
  if (n < 0) return n; // уже в форме Bot API
  return Number(`-100${n}`);
}

export function parseExport(raw: unknown): ImportedChannel[] {
  const root = raw as { chats?: { list?: unknown[] } } | null;
  const list = root?.chats?.list;
  if (!Array.isArray(list)) {
    throw new Error('не нашёл chats.list — это не result.json из экспорта Telegram');
  }

  const out = new Map<number, ImportedChannel>();
  for (const entry of list) {
    const chat = entry as { type?: unknown; id?: unknown; name?: unknown; username?: unknown };
    if (typeof chat.type !== 'string' || !CHANNEL_TYPES.has(chat.type)) continue;
    if (typeof chat.id !== 'number' && typeof chat.id !== 'string') continue;

    const chatId = normalizeChannelId(chat.id);
    out.set(chatId, {
      chatId,
      username: typeof chat.username === 'string' ? chat.username.replace(/^@/, '') : null,
      title: typeof chat.name === 'string' ? chat.name : null,
    });
  }
  return [...out.values()];
}

const HANDLE = /^[a-zA-Z0-9_]{4,32}$/;

/** Список подписок текстом: `@handle`, `t.me/handle`, голое имя — по строке. */
export function parseHandleList(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/[\s,;]+/)) {
    const handle = line
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^t\.me\//i, '')
      .replace(/^@/, '')
      .replace(/[/?].*$/, '');
    if (handle && HANDLE.test(handle)) out.add(handle);
  }
  return [...out];
}

/**
 * RFC §8.1: экспорт можно перезаливать. Метки при этом обязаны выживать,
 * поэтому по outbound_subs идёт do nothing, а не update — новые подписки
 * попадают в unlabeled, старые остаются размеченными.
 * Возвращает число реально новых записей.
 */
export async function saveImported(
  ownerUserId: number,
  items: ImportedChannel[],
  source: 'export' | 'manual' | 'deal',
): Promise<number> {
  if (items.length === 0) return 0;

  let added = 0;
  for (let i = 0; i < items.length; i += 200) {
    const chunk = items.slice(i, i + 200);

    await db
      .insert(channels)
      .values(chunk.map((c) => ({ chatId: c.chatId, username: c.username, title: c.title })))
      .onConflictDoUpdate({
        target: channels.chatId,
        set: {
          username: sqlExcluded('username'),
          title: sqlExcluded('title'),
        },
      });

    const rows = await db
      .insert(outboundSubs)
      .values(chunk.map((c) => ({
        ownerUserId,
        chatId: c.chatId,
        label: 'unlabeled',
        status: 'active',
        source,
      })))
      .onConflictDoNothing({ target: [outboundSubs.ownerUserId, outboundSubs.chatId] })
      .returning({ id: outboundSubs.id });

    added += rows.length;

    // Канал снова в экспорте — значит подписка снова есть. Иначе один раз
    // сказанное «я отписался» (status='left') запирало бы запись навсегда:
    // do nothing выше её не тронет, а в разметку она уже не попадёт.
    await db
      .update(outboundSubs)
      .set({ status: 'active' })
      .where(and(
        eq(outboundSubs.ownerUserId, ownerUserId),
        eq(outboundSubs.status, 'left'),
        inArray(outboundSubs.chatId, chunk.map((c) => c.chatId)),
      ));
  }
  return added;
}

/** `excluded.<col>` в upsert: не затираем известное значение приходящим null. */
function sqlExcluded(column: 'username' | 'title') {
  return sql`coalesce(excluded.${sql.raw(column)}, ${channels[column]})`;
}
