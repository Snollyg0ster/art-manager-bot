import { InlineKeyboard, type Api } from 'grammy';
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  channels, memberships, outboundSubs, pairs, triageItems, userChannelLinks, users,
  type ChannelHint, type JoinedPayload, type MatchPayload,
} from '../db/schema.js';
import { personalChannelOf, saveChannelHint } from './channels.js';
import { bindAndWatch } from './pairs.js';
import { channelLabel } from './triage.js';

/** Сколько дней подписка считается новой: дальше это просто подписчик. */
const WINDOW_DAYS = 30;

/** Сколько подписчиков показываем за раз, чтобы отчёт не превращался в простыню. */
const PAGE = 10;

/**
 * Сколько getChat зовём за один сбор подсказок. Ограничение из RFC §5.3:
 * getChat под флуд-контролем, а подписок в канале может быть много.
 */
const MAX_HINT_LOOKUPS = 10;

export type NewSubscriber = {
  userId: number;
  /** Канал владельца, куда подписались. */
  chatId: number;
  username: string | null;
  displayName: string | null;
  who: string;
  joinedAt: Date;
  /** Канал человека, если известен: связь §8.3 или свежий personal_chat. */
  channel: ChannelHint | null;
  /** id карточки kind='joined', если она уже создана. */
  itemId: number | null;
};

export type NewSubscribers = {
  items: NewSubscriber[];
  /** Сколько ещё осталось за пределами страницы — показываем честно. */
  more: number;
};

function who(username: string | null, displayName: string | null, userId: number): string {
  const handle = username ? `@${username}` : null;
  if (handle && displayName) return `${handle} (${displayName})`;
  return handle ?? displayName ?? `id${userId}`;
}

/**
 * Подписались на канал владельца и всё ещё на месте, а владелец им в ответ
 * не подписан. Уходы сюда не попадают: это ветка §8.2 и карточки kind='left'.
 *
 * Считаем по проекции memberships, а не по логу: для status='member' её since —
 * это как раз время последней подписки.
 */
export async function newSubscribers(api: Api, ownerUserId: number): Promise<NewSubscribers> {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

  const joined = await db
    .select({
      userId: memberships.userId,
      chatId: memberships.chatId,
      joinedAt: memberships.since,
      username: users.username,
      displayName: users.displayName,
    })
    .from(memberships)
    .innerJoin(channels, eq(channels.chatId, memberships.chatId))
    .leftJoin(users, eq(users.tgUserId, memberships.userId))
    .where(and(
      eq(channels.ownerUserId, ownerUserId),
      eq(memberships.status, 'member'),
      gte(memberships.since, cutoff),
    ))
    .orderBy(desc(memberships.since));

  // Сам владелец в своём канале подписчиком не считается.
  const candidates = joined.filter((r) => r.userId !== ownerUserId && r.joinedAt);
  if (candidates.length === 0) return { items: [], more: 0 };

  const ids = candidates.map((c) => c.userId);
  const [handled, links] = await Promise.all([
    joinedItemsByUser(ownerUserId),
    knownChannels(ownerUserId, ids),
  ]);

  const fresh: Array<NewSubscriber & { skip?: boolean }> = [];
  for (const c of candidates) {
    const item = handled.get(c.userId);
    // Разобранное не показываем повторно: 'resolved' — записали мью,
    // 'dismissed' — владелец сказал «не интересно».
    if (item && item.state !== 'open') continue;

    const link = links.get(c.userId);
    if (link?.subscribed) continue; // уже подписан в ответ — это не кандидат

    fresh.push({
      userId: c.userId,
      chatId: c.chatId,
      username: c.username,
      displayName: c.displayName,
      who: who(c.username, c.displayName, c.userId),
      joinedAt: c.joinedAt!,
      channel: link?.channel ?? null,
      itemId: item?.id ?? null,
    });
  }

  const page = fresh.slice(0, PAGE);
  await fillChannels(api, ownerUserId, page);

  return {
    items: page.filter((s) => !s.skip).map(({ skip: _skip, ...s }) => s),
    more: Math.max(0, fresh.length - page.length),
  };
}

/**
 * Кого уже спрашивали и канала не нашли. Иначе каждый показ отчёта тратил бы
 * getChat на одних и тех же людей без канала в профиле, а он под флуд-контролем
 * (§5.3). Живёт до перезапуска: привязка канала к профилю — дело редкое, но
 * не запретное, так что вечно помнить отказ нельзя.
 */
const noChannel = new Set<number>();

/**
 * Добор канала через personal_chat для тех, о ком связи ещё нет (§8.3 п.1).
 * Если выяснится, что владелец на этот канал уже подписан, кандидат отпадает:
 * мью уже есть, просто человек не был связан с каналом.
 */
async function fillChannels(
  api: Api,
  ownerUserId: number,
  page: Array<NewSubscriber & { skip?: boolean }>,
): Promise<void> {
  let lookups = 0;

  for (const s of page) {
    if (s.channel || noChannel.has(s.userId)) continue;
    if (lookups >= MAX_HINT_LOOKUPS) break;

    lookups += 1;
    const hint = await personalChannelOf(api, s.userId);
    if (!hint) {
      noChannel.add(s.userId);
      continue;
    }

    await saveChannelHint(s.userId, hint);
    if (await isSubscribed(ownerUserId, hint.chatId)) {
      s.skip = true;
      continue;
    }
    s.channel = hint;
  }
}

async function isSubscribed(ownerUserId: number, chatId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: outboundSubs.id })
    .from(outboundSubs)
    .where(and(
      eq(outboundSubs.ownerUserId, ownerUserId),
      eq(outboundSubs.chatId, chatId),
      eq(outboundSubs.status, 'active'),
    ))
    .limit(1);
  return row !== undefined;
}

/** Карточки kind='joined' этого владельца, по user_id из payload. */
async function joinedItemsByUser(
  ownerUserId: number,
): Promise<Map<number, { id: number; state: string }>> {
  const rows = await db
    .select({
      id: triageItems.id,
      state: triageItems.state,
      userId: sql<string>`${triageItems.payload}->>'userId'`,
    })
    .from(triageItems)
    .where(and(eq(triageItems.ownerUserId, ownerUserId), eq(triageItems.kind, 'joined')))
    .orderBy(asc(triageItems.id));

  const map = new Map<number, { id: number; state: string }>();
  for (const r of rows) map.set(Number(r.userId), { id: r.id, state: r.state });
  return map;
}

/** Известный канал человека и подписан ли на него владелец. */
async function knownChannels(
  ownerUserId: number,
  userIds: number[],
): Promise<Map<number, { channel: ChannelHint | null; subscribed: boolean }>> {
  const rows = await db
    .select({
      userId: userChannelLinks.userId,
      chatId: userChannelLinks.chatId,
      username: channels.username,
      title: channels.title,
      subId: outboundSubs.id,
    })
    .from(userChannelLinks)
    .leftJoin(channels, eq(channels.chatId, userChannelLinks.chatId))
    .leftJoin(outboundSubs, and(
      eq(outboundSubs.chatId, userChannelLinks.chatId),
      eq(outboundSubs.ownerUserId, ownerUserId),
      eq(outboundSubs.status, 'active'),
    ))
    .where(inArray(userChannelLinks.userId, userIds));

  const map = new Map<number, { channel: ChannelHint | null; subscribed: boolean }>();
  for (const r of rows) {
    const prev = map.get(r.userId);
    map.set(r.userId, {
      channel: prev?.channel ?? { chatId: r.chatId, username: r.username, title: r.title },
      subscribed: (prev?.subscribed ?? false) || r.subId !== null,
    });
  }
  return map;
}

/** Карточка нужна, чтобы кнопки на что-то ссылались, а «скрыть» помнилось. */
export async function ensureJoinedItem(
  ownerUserId: number,
  s: NewSubscriber,
): Promise<number> {
  if (s.itemId) return s.itemId;

  const payload: JoinedPayload = {
    chatId: s.chatId,
    userId: s.userId,
    username: s.username,
    displayName: s.displayName,
    joinedAt: s.joinedAt.toISOString(),
    ...(s.channel ? { channelHint: s.channel } : {}),
  };

  const [row] = await db
    .insert(triageItems)
    .values({ ownerUserId, kind: 'joined', payload, state: 'open' })
    .returning({ id: triageItems.id });

  return row!.id;
}

export async function getJoinedItem(
  itemId: number,
  ownerUserId: number,
): Promise<{ id: number; payload: JoinedPayload } | null> {
  const [row] = await db
    .select({ id: triageItems.id, payload: triageItems.payload })
    .from(triageItems)
    .where(and(
      eq(triageItems.id, itemId),
      eq(triageItems.ownerUserId, ownerUserId),
      eq(triageItems.kind, 'joined'),
    ))
    .limit(1);

  // kind='joined' в условии — значит payload именно этой формы.
  return row ? { id: row.id, payload: row.payload as JoinedPayload } : null;
}

/** «Подписался в ответ»: мью записывается, пара уходит под наблюдение. */
export async function acceptJoined(
  ownerUserId: number,
  item: { id: number; payload: JoinedPayload },
): Promise<ChannelHint | null> {
  const hint = item.payload.channelHint;
  if (!hint) return null;

  await bindAndWatch({
    ownerUserId,
    counterpartUserId: item.payload.userId,
    counterpartChatId: hint.chatId,
  });
  await setJoinedState(ownerUserId, item.id, 'resolved');
  return hint;
}

export type MatchAsk = {
  itemId: number;
  who: string;
  channel: ChannelHint;
};

export type MatchOutcome =
  | { kind: 'none' }
  | { kind: 'linked'; who: string; channel: ChannelHint }
  | { kind: 'ask'; ask: MatchAsk };

/**
 * RFC §8.4: «контрагент подставится при первом событии». Подписался человек —
 * возможно, это владелец канала, с которым у нас записано мью, а в паре стоит
 * NULL вместо его user_id.
 *
 * По подтверждённой связи ('manual' | 'owner') пара склеивается сама. Догадку
 * из personal_chat подтверждает владелец: §8.3 разрешает автоматику только на
 * подтверждённых уровнях, а ошибка здесь means следить за чужим человеком.
 */
export async function resolveCounterpartOnJoin(
  api: Api,
  ownerUserId: number,
  chatId: number,
  userId: number,
): Promise<MatchOutcome> {
  // Дешёвая отсечка: без пар без контрагента разбирать нечего, и getChat не нужен.
  const open = await unresolvedPairChats(ownerUserId);
  if (open.size === 0) return { kind: 'none' };

  const already = await db
    .select({ id: pairs.id })
    .from(pairs)
    .where(and(eq(pairs.ownerUserId, ownerUserId), eq(pairs.counterpartUserId, userId)))
    .limit(1);
  if (already.length > 0) return { kind: 'none' };

  const person = await personName(userId);

  const confirmed = await db
    .select({
      chatId: userChannelLinks.chatId,
      username: channels.username,
      title: channels.title,
    })
    .from(userChannelLinks)
    .leftJoin(channels, eq(channels.chatId, userChannelLinks.chatId))
    .where(and(
      eq(userChannelLinks.userId, userId),
      inArray(userChannelLinks.confidence, ['manual', 'owner']),
    ));

  for (const link of confirmed) {
    if (!open.has(link.chatId)) continue;
    const channel = { chatId: link.chatId, username: link.username, title: link.title };
    await bindAndWatch({ ownerUserId, counterpartUserId: userId, counterpartChatId: link.chatId });
    return { kind: 'linked', who: person.who, channel };
  }

  const hint = await channelGuess(api, userId);
  if (!hint || !open.has(hint.chatId)) return { kind: 'none' };

  const pairId = open.get(hint.chatId)!;
  if (await matchAsked(ownerUserId, userId, pairId)) return { kind: 'none' };

  const payload: MatchPayload = {
    chatId,
    userId,
    username: person.username,
    displayName: person.displayName,
    pairId,
    channelHint: hint,
  };
  const [row] = await db
    .insert(triageItems)
    .values({ ownerUserId, kind: 'match', payload, state: 'open' })
    .returning({ id: triageItems.id });

  return { kind: 'ask', ask: { itemId: row!.id, who: person.who, channel: hint } };
}

/** Пары, где канал известен, а человек — нет: chat_id → id пары. */
async function unresolvedPairChats(ownerUserId: number): Promise<Map<number, number>> {
  const rows = await db
    .select({ id: pairs.id, chatId: pairs.counterpartChatId })
    .from(pairs)
    .where(and(
      eq(pairs.ownerUserId, ownerUserId),
      isNull(pairs.counterpartUserId),
      ne(pairs.state, 'closed'),
    ));

  const map = new Map<number, number>();
  for (const r of rows) map.set(r.chatId, r.id);
  return map;
}

async function personName(userId: number) {
  const [u] = await db
    .select({ username: users.username, displayName: users.displayName })
    .from(users)
    .where(eq(users.tgUserId, userId))
    .limit(1);
  const username = u?.username ?? null;
  const displayName = u?.displayName ?? null;
  return { username, displayName, who: who(username, displayName, userId) };
}

/** Канал человека: сперва уже известная связь, иначе personal_chat. */
async function channelGuess(api: Api, userId: number): Promise<ChannelHint | null> {
  const [link] = await db
    .select({
      chatId: userChannelLinks.chatId,
      username: channels.username,
      title: channels.title,
    })
    .from(userChannelLinks)
    .leftJoin(channels, eq(channels.chatId, userChannelLinks.chatId))
    .where(eq(userChannelLinks.userId, userId))
    .limit(1);
  if (link) return { chatId: link.chatId, username: link.username, title: link.title };

  if (noChannel.has(userId)) return null;
  const hint = await personalChannelOf(api, userId);
  if (!hint) {
    noChannel.add(userId);
    return null;
  }
  await saveChannelHint(userId, hint);
  return hint;
}

/** Спрашивали ли уже про эту пару и этого человека — неважно, что ответили. */
async function matchAsked(
  ownerUserId: number,
  userId: number,
  pairId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: triageItems.id })
    .from(triageItems)
    .where(and(
      eq(triageItems.ownerUserId, ownerUserId),
      eq(triageItems.kind, 'match'),
      sql`${triageItems.payload}->>'userId' = ${String(userId)}`,
      sql`${triageItems.payload}->>'pairId' = ${String(pairId)}`,
    ))
    .limit(1);
  return row !== undefined;
}

export function renderMatchCard(ask: MatchAsk): string {
  return [
    `🔗 Подписался ${ask.who}`,
    `   В журнале у тебя мью с ${channelLabel(ask.channel)}, и похоже, это его канал.`,
    '',
    '   Это он? Подтвердишь — начну следить за парой и замечу, если он уйдёт.',
  ].join('\n');
}

export function matchKeyboard(itemId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('Да, он', `p:${itemId}:y`)
    .text('Нет', `p:${itemId}:n`);
}

export async function getMatchItem(
  itemId: number,
  ownerUserId: number,
): Promise<{ id: number; payload: MatchPayload } | null> {
  const [row] = await db
    .select({ id: triageItems.id, payload: triageItems.payload })
    .from(triageItems)
    .where(and(
      eq(triageItems.id, itemId),
      eq(triageItems.ownerUserId, ownerUserId),
      eq(triageItems.kind, 'match'),
    ))
    .limit(1);

  return row ? { id: row.id, payload: row.payload as MatchPayload } : null;
}

/** Владелец подтвердил догадку: связь становится 'manual', пара — 'watching'. */
export async function acceptMatch(
  ownerUserId: number,
  item: { id: number; payload: MatchPayload },
): Promise<ChannelHint> {
  await bindAndWatch({
    ownerUserId,
    counterpartUserId: item.payload.userId,
    counterpartChatId: item.payload.channelHint.chatId,
  });
  await setJoinedState(ownerUserId, item.id, 'resolved');
  return item.payload.channelHint;
}

export async function setJoinedState(
  ownerUserId: number,
  itemId: number,
  state: 'resolved' | 'dismissed',
): Promise<void> {
  await db
    .update(triageItems)
    .set({ state })
    .where(and(eq(triageItems.id, itemId), eq(triageItems.ownerUserId, ownerUserId)));
}
