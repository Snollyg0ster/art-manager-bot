import { and, asc, count, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channels, outboundSubs, pairs, userChannelLinks } from '../db/schema.js';

/** RFC §7.1 */
export type PairState = 'watching' | 'broken' | 'returned' | 'unresolved' | 'closed';

/** RFC §7, ось 1. */
export type SubLabel = 'mutual' | 'not_mutual' | 'unlabeled';

export type Pair = typeof pairs.$inferSelect;

export async function findPairByCounterpartUser(
  ownerUserId: number,
  counterpartUserId: number,
): Promise<Pair | null> {
  const [row] = await db
    .select()
    .from(pairs)
    .where(and(
      eq(pairs.ownerUserId, ownerUserId),
      eq(pairs.counterpartUserId, counterpartUserId),
    ))
    .limit(1);
  return row ?? null;
}

export async function setPairState(pairId: number, state: PairState): Promise<void> {
  await db
    .update(pairs)
    .set({ state, stateChangedAt: new Date() })
    .where(eq(pairs.id, pairId));
}

/** RFC §8.4: `/add @channel` — канал знаем, человека нет. */
export async function addUnresolvedPair(ownerUserId: number, chatId: number): Promise<void> {
  await db
    .insert(pairs)
    .values({ ownerUserId, counterpartChatId: chatId, state: 'unresolved' })
    .onConflictDoNothing({ target: [pairs.ownerUserId, pairs.counterpartChatId] });

  // Мью заводят заново после того, как от канала отписывались: пара уже есть,
  // но лежит в closed, и без этого она бы там и осталась.
  await db
    .update(pairs)
    .set({ state: 'unresolved', stateChangedAt: new Date() })
    .where(and(
      eq(pairs.ownerUserId, ownerUserId),
      eq(pairs.counterpartChatId, chatId),
      eq(pairs.state, 'closed'),
    ));

  await db
    .insert(outboundSubs)
    .values({
      ownerUserId,
      chatId,
      label: 'mutual',
      source: 'manual',
      labeledAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [outboundSubs.ownerUserId, outboundSubs.chatId],
      // status тоже: запись могла лежать в 'left' после «я отписался»,
      // и тогда новое мью не увидели бы ни отчёт, ни разметка.
      set: { label: 'mutual', status: 'active', labeledAt: new Date() },
    });
}

/**
 * Владелец своей рукой подтвердил связь человек ↔ канал, поэтому
 * confidence='manual': только на нём и на 'owner' RFC §8.3 разрешает
 * автоматические действия.
 */
export async function bindPair(input: {
  ownerUserId: number;
  counterpartUserId: number;
  counterpartChatId: number;
  state: PairState;
  /** Откуда подтверждение: 'triage' — карточка ухода, 'joined' — новый подписчик. */
  source: string;
}): Promise<void> {
  const { ownerUserId, counterpartUserId, counterpartChatId, state, source } = input;

  await db
    .insert(userChannelLinks)
    .values({
      userId: counterpartUserId,
      chatId: counterpartChatId,
      confidence: 'manual',
      source,
    })
    .onConflictDoUpdate({
      target: [userChannelLinks.userId, userChannelLinks.chatId],
      set: { confidence: 'manual', source },
    });

  await db
    .insert(pairs)
    .values({
      ownerUserId,
      counterpartUserId,
      counterpartChatId,
      state,
    })
    .onConflictDoUpdate({
      target: [pairs.ownerUserId, pairs.counterpartChatId],
      set: { counterpartUserId, state, stateChangedAt: new Date() },
    });

  await db
    .insert(outboundSubs)
    .values({
      ownerUserId,
      chatId: counterpartChatId,
      label: 'mutual',
      source: 'manual',
      labeledAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [outboundSubs.ownerUserId, outboundSubs.chatId],
      // status возвращаем в 'active': подтверждая мью, владелец говорит, что
      // подписан. Иначе прошлое «я отписался» навсегда скрыло бы запись.
      set: { label: 'mutual', status: 'active', labeledAt: new Date() },
    });
}

/**
 * RFC §8.2, ветка «да, это мью» в карточке ухода. Пара сразу уходит в broken —
 * уход уже случился, иначе бы карточки не было.
 */
export function bindAndBreak(input: {
  ownerUserId: number;
  counterpartUserId: number;
  counterpartChatId: number;
}): Promise<void> {
  return bindPair({ ...input, state: 'broken', source: 'triage' });
}

/**
 * Разбор нового подписчика: человек на месте, владелец подписался в ответ.
 * Отсюда состояние 'watching' по RFC §7.1 — обе стороны известны и не
 * опровергнуты, дальше пару ведёт ежесуточная сверка §10.
 */
export function bindAndWatch(input: {
  ownerUserId: number;
  counterpartUserId: number;
  counterpartChatId: number;
}): Promise<void> {
  return bindPair({ ...input, state: 'watching', source: 'joined' });
}

/**
 * RFC §7: status='left' — владелец больше не подписан. Без этого счётчик
 * «взаимно» продолжал бы считать канал, а человек не вернулся бы в «новые
 * подписчики»: там проверка идёт по активным записям журнала.
 */
export async function markSubLeft(ownerUserId: number, chatId: number): Promise<void> {
  await db
    .update(outboundSubs)
    .set({ status: 'left' })
    .where(and(eq(outboundSubs.ownerUserId, ownerUserId), eq(outboundSubs.chatId, chatId)));
}

/** RFC §9: «Отписался, готово» — владелец отписался руками, вопрос закрыт. */
export async function closePair(pairId: number, ownerUserId: number): Promise<boolean> {
  const rows = await db
    .update(pairs)
    .set({ state: 'closed', stateChangedAt: new Date() })
    .where(and(eq(pairs.id, pairId), eq(pairs.ownerUserId, ownerUserId)))
    .returning({ chatId: pairs.counterpartChatId });

  const chatId = rows[0]?.chatId;
  if (chatId === undefined) return false;

  await markSubLeft(ownerUserId, chatId);
  return true;
}

export type MutualSub = {
  id: number;
  chatId: number;
  username: string | null;
  title: string | null;
};

function activeMutual(ownerUserId: number) {
  return and(
    eq(outboundSubs.ownerUserId, ownerUserId),
    eq(outboundSubs.label, 'mutual'),
    eq(outboundSubs.status, 'active'),
  );
}

/** Действующие мью: то, от чего владелец может сказать «я отписался». */
export async function mutualSubs(
  ownerUserId: number,
  limit: number,
  offset = 0,
): Promise<MutualSub[]> {
  return db
    .select({
      id: outboundSubs.id,
      chatId: outboundSubs.chatId,
      username: channels.username,
      title: channels.title,
    })
    .from(outboundSubs)
    .leftJoin(channels, eq(channels.chatId, outboundSubs.chatId))
    .where(activeMutual(ownerUserId))
    .orderBy(asc(outboundSubs.id))
    .limit(limit)
    .offset(offset);
}

export async function mutualSubsCount(ownerUserId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(outboundSubs)
    .where(activeMutual(ownerUserId));
  return Number(row?.n ?? 0);
}

/** Поиск по каналу для `/unsub @handle`. */
export async function mutualSubByChat(
  ownerUserId: number,
  chatId: number,
): Promise<MutualSub | null> {
  const [row] = await db
    .select({
      id: outboundSubs.id,
      chatId: outboundSubs.chatId,
      username: channels.username,
      title: channels.title,
    })
    .from(outboundSubs)
    .leftJoin(channels, eq(channels.chatId, outboundSubs.chatId))
    .where(and(activeMutual(ownerUserId), eq(outboundSubs.chatId, chatId)))
    .limit(1);
  return row ?? null;
}

/**
 * «Я отписался» вне контекста ухода. Пара по этому каналу тоже закрывается:
 * наблюдать за ней больше не за чем, мью кончилось по решению владельца.
 */
export async function dropSub(subId: number, ownerUserId: number): Promise<boolean> {
  const rows = await db
    .update(outboundSubs)
    .set({ status: 'left' })
    .where(and(eq(outboundSubs.id, subId), eq(outboundSubs.ownerUserId, ownerUserId)))
    .returning({ chatId: outboundSubs.chatId });

  const chatId = rows[0]?.chatId;
  if (chatId === undefined) return false;

  await db
    .update(pairs)
    .set({ state: 'closed', stateChangedAt: new Date() })
    .where(and(eq(pairs.ownerUserId, ownerUserId), eq(pairs.counterpartChatId, chatId)));

  return true;
}

export type UnlabeledSub = {
  id: number;
  chatId: number;
  username: string | null;
  title: string | null;
};

export async function nextUnlabeled(ownerUserId: number): Promise<UnlabeledSub | null> {
  const [row] = await db
    .select({
      id: outboundSubs.id,
      chatId: outboundSubs.chatId,
      username: channels.username,
      title: channels.title,
    })
    .from(outboundSubs)
    .leftJoin(channels, eq(channels.chatId, outboundSubs.chatId))
    .where(and(
      eq(outboundSubs.ownerUserId, ownerUserId),
      eq(outboundSubs.label, 'unlabeled'),
      eq(outboundSubs.status, 'active'),
    ))
    // Нетронутые записи идут первыми, отложенные («пропустить») — в конце.
    .orderBy(sql`${outboundSubs.labeledAt} asc nulls first`, asc(outboundSubs.id))
    .limit(1);
  return row ?? null;
}

/**
 * Разметка из §8.1. 'mutual' заодно заводит пару в unresolved:
 * канал известен, человек — нет, это штатное состояние (RFC §7.1).
 */
export async function labelSub(
  subId: number,
  ownerUserId: number,
  label: SubLabel,
): Promise<void> {
  const rows = await db
    .update(outboundSubs)
    .set({ label, labeledAt: new Date() })
    .where(and(eq(outboundSubs.id, subId), eq(outboundSubs.ownerUserId, ownerUserId)))
    .returning({ chatId: outboundSubs.chatId });

  const chatId = rows[0]?.chatId;
  if (label !== 'mutual' || chatId === undefined) return;

  await db
    .insert(pairs)
    .values({ ownerUserId, counterpartChatId: chatId, state: 'unresolved' })
    .onConflictDoNothing({ target: [pairs.ownerUserId, pairs.counterpartChatId] });
}

/**
 * «Пропустить»: метка не ставится, но время касания обновляется —
 * запись уезжает в конец очереди nextUnlabeled и не зациклит разметку.
 */
export async function deferSub(subId: number, ownerUserId: number): Promise<void> {
  await db
    .update(outboundSubs)
    .set({ labeledAt: new Date() })
    .where(and(eq(outboundSubs.id, subId), eq(outboundSubs.ownerUserId, ownerUserId)));
}
