import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channels, outboundSubs, pairs, userChannelLinks } from '../db/schema.js';

/** RFC §7.1 */
export type PairState = 'watching' | 'broken' | 'returned' | 'unresolved' | 'closed';

/** RFC §7, ось 1. */
export type SubLabel = 'mutual' | 'not_mutual' | 'unlabeled';

export type Pair = typeof pairs.$inferSelect;

export async function ownerOfChannel(chatId: number): Promise<number | null> {
  const [row] = await db
    .select({ ownerUserId: channels.ownerUserId })
    .from(channels)
    .where(eq(channels.chatId, chatId))
    .limit(1);
  return row?.ownerUserId ?? null;
}

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
      set: { label: 'mutual', labeledAt: new Date() },
    });
}

/**
 * RFC §8.2, ветка «да, это мью». Владелец подтвердил связь человек ↔ канал,
 * поэтому confidence='manual': на нём автоматические действия разрешены (§8.3).
 * Пара сразу уходит в broken — уход уже случился, иначе бы карточки не было.
 */
export async function bindAndBreak(input: {
  ownerUserId: number;
  counterpartUserId: number;
  counterpartChatId: number;
}): Promise<void> {
  const { ownerUserId, counterpartUserId, counterpartChatId } = input;

  await db
    .insert(userChannelLinks)
    .values({
      userId: counterpartUserId,
      chatId: counterpartChatId,
      confidence: 'manual',
      source: 'triage',
    })
    .onConflictDoUpdate({
      target: [userChannelLinks.userId, userChannelLinks.chatId],
      set: { confidence: 'manual', source: 'triage' },
    });

  await db
    .insert(pairs)
    .values({
      ownerUserId,
      counterpartUserId,
      counterpartChatId,
      state: 'broken',
    })
    .onConflictDoUpdate({
      target: [pairs.ownerUserId, pairs.counterpartChatId],
      set: { counterpartUserId, state: 'broken', stateChangedAt: new Date() },
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
      set: { label: 'mutual', labeledAt: new Date() },
    });
}

/** RFC §9: «Отписался, готово» — владелец отписался руками, вопрос закрыт. */
export async function closePair(pairId: number, ownerUserId: number): Promise<boolean> {
  const rows = await db
    .update(pairs)
    .set({ state: 'closed', stateChangedAt: new Date() })
    .where(and(eq(pairs.id, pairId), eq(pairs.ownerUserId, ownerUserId)))
    .returning({ id: pairs.id });
  return rows.length > 0;
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
