import type { Api } from 'grammy';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channels, userChannelLinks, type ChannelHint } from '../db/schema.js';

/**
 * RFC §14. getChatAdministrators, вызванный из обработчика my_chat_member,
 * отвечает «400 member list is inaccessible»: в этот момент права бота ещё не
 * видны Telegram. Через секунду тот же вызов проходит, поэтому повторы.
 *
 * Без них owner_user_id остаётся NULL навсегда — второго my_chat_member не
 * будет, пока права не поменяют руками, — а с NULL молча отключается весь §8.2.
 */
const OWNER_RETRY_DELAYS_MS = [0, 1200, 3000];

export async function fetchChannelOwner(api: Api, chatId: number): Promise<number | null> {
  let lastError: unknown;

  for (const delay of OWNER_RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    try {
      const admins = await api.getChatAdministrators(chatId);
      return admins.find((a) => a.status === 'creator')?.user.id ?? null;
    } catch (e) {
      lastError = e;
    }
  }

  // Только сообщение: у grammy внутри ошибки лежит URL запроса, а в нём токен.
  console.error('getChatAdministrators не прошёл', chatId, reason(lastError));
  return null;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Владелец канала из базы, без обращения к Telegram. */
export async function ownerOfChannel(chatId: number): Promise<number | null> {
  const [row] = await db
    .select({ ownerUserId: channels.ownerUserId })
    .from(channels)
    .where(eq(channels.chatId, chatId))
    .limit(1);
  return row?.ownerUserId ?? null;
}

/**
 * Владелец из базы, а если его там нет — добор из Telegram и запись.
 * Страховка на случай, когда онбординг creator так и не получил: иначе одна
 * неудача при выдаче прав навсегда выключает разбор уходов.
 */
export async function ensureChannelOwner(api: Api, chatId: number): Promise<number | null> {
  const known = await ownerOfChannel(chatId);
  if (known) return known;

  const ownerUserId = await fetchChannelOwner(api, chatId);
  if (!ownerUserId) return null;

  await db
    .insert(channels)
    .values({ chatId, ownerUserId })
    .onConflictDoUpdate({ target: channels.chatId, set: { ownerUserId } });

  return ownerUserId;
}

/**
 * RFC §8.3 п.1 — лучшая из подсказок канала. Проба §5.2 подтвердила вживую:
 * getChat резолвится и для человека, который бота не запускал, и отдаёт
 * personal_chat — канал, привязанный к его профилю.
 */
export async function personalChannelOf(api: Api, userId: number): Promise<ChannelHint | null> {
  try {
    const chat = await api.getChat(userId);
    const personal = 'personal_chat' in chat ? chat.personal_chat : undefined;
    if (!personal || personal.type !== 'channel') return null;

    return {
      chatId: personal.id,
      username: personal.username ?? null,
      title: personal.title ?? null,
    };
  } catch (e) {
    // Канал в профиле — дело добровольное, отсутствие подсказки не ошибка.
    console.error('getChat для подсказки канала не прошёл', userId, reason(e));
    return null;
  }
}

/**
 * RFC §8.3: 'personal' — предположение, автоматические действия на нём
 * запрещены. onConflictDoNothing именно поэтому: подтверждённую владельцем
 * связь ('manual') подсказка понижать не должна.
 */
export async function saveChannelHint(userId: number, hint: ChannelHint): Promise<void> {
  await db
    .insert(channels)
    .values({ chatId: hint.chatId, username: hint.username, title: hint.title })
    .onConflictDoUpdate({
      target: channels.chatId,
      set: { username: hint.username, title: hint.title },
    });

  await db
    .insert(userChannelLinks)
    .values({
      userId,
      chatId: hint.chatId,
      confidence: 'personal',
      source: 'personal_chat',
    })
    .onConflictDoNothing({ target: [userChannelLinks.userId, userChannelLinks.chatId] });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
