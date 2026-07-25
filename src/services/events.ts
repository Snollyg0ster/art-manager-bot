import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { ChatMember } from 'grammy/types';
import { db } from '../db/index.js';
import { membershipEvents, memberships, users } from '../db/schema.js';

export type MembershipEventType = 'join' | 'leave' | 'kick' | 'unban';

/**
 * 'restricted' означает участника только при is_member: true —
 * иначе это ограниченный не-участник.
 */
export function isMember(m: ChatMember): boolean {
  switch (m.status) {
    case 'creator':
    case 'administrator':
    case 'member':
      return true;
    case 'restricted':
      return m.is_member;
    default:
      return false;
  }
}

export function classify(before: ChatMember, after: ChatMember): MembershipEventType | null {
  const was = isMember(before);
  const now = isMember(after);
  if (!was && now) return before.status === 'kicked' ? 'unban' : 'join';
  if (was && !now) return after.status === 'kicked' ? 'kick' : 'leave';
  return null;
}

export type AppendEventInput = {
  chatId: number;
  userId: number;
  event: MembershipEventType;
  at: Date;
  atPrecision: 'exact' | 'window';
  observedVia: 'chat_member' | 'reconcile' | 'export';
  updateId?: number | null;
};

/**
 * RFC §7.2. Дедуп ретраев вебхука через unique(update_id).
 * Возвращает null, если событие уже было записано — вызывающий код
 * должен в этом случае прекратить обработку.
 */
export async function appendEvent(input: AppendEventInput): Promise<{ id: number } | null> {
  const rows = await db
    .insert(membershipEvents)
    .values({
      chatId: input.chatId,
      userId: input.userId,
      event: input.event,
      at: input.at,
      atPrecision: input.atPrecision,
      observedVia: input.observedVia,
      updateId: input.updateId ?? null,
    })
    .onConflictDoNothing({ target: membershipEvents.updateId })
    .returning({ id: membershipEvents.id });

  return rows[0] ?? null;
}

/**
 * RFC §7.2: проекция пересобирается из лога целиком, а не патчится.
 * Полный реплей по одному пользователю дёшев и защищает от багов
 * в обработчиках переходов.
 */
export async function projectMembership(chatId: number, userId: number): Promise<void> {
  const log = await db
    .select()
    .from(membershipEvents)
    .where(and(eq(membershipEvents.chatId, chatId), eq(membershipEvents.userId, userId)))
    .orderBy(asc(membershipEvents.at), asc(membershipEvents.id));

  if (log.length === 0) return;

  let status: 'member' | 'left' | 'kicked' = 'left';
  let since: Date | null = null;
  let leaveCount = 0;

  for (const e of log) {
    switch (e.event) {
      case 'join':
      case 'unban':
        if (status !== 'member') since = e.at;
        status = 'member';
        break;
      case 'leave':
        if (status === 'member') leaveCount += 1;
        status = 'left';
        since = e.at;
        break;
      case 'kick':
        if (status === 'member') leaveCount += 1;
        status = 'kicked';
        since = e.at;
        break;
    }
  }

  const last = log[log.length - 1]!;

  await db
    .insert(memberships)
    .values({ chatId, userId, status, since, lastEventId: last.id, leaveCount })
    .onConflictDoUpdate({
      target: [memberships.chatId, memberships.userId],
      set: { status, since, lastEventId: last.id, leaveCount },
    });
}

/** Вернулся ли пользователь после указанного события. RFC §8.2 */
export async function hasReturnedSince(
  chatId: number,
  userId: number,
  eventId: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: membershipEvents.id })
    .from(membershipEvents)
    .where(
      and(
        eq(membershipEvents.chatId, chatId),
        eq(membershipEvents.userId, userId),
        gt(membershipEvents.id, eventId),
        sql`${membershipEvents.event} in ('join', 'unban')`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Время и точность события по его id. Нужно карточке триажа: задача приходит
 * не раньше чем через grace, и RFC §10 прямо запрещает выдавать время
 * обнаружения за время ухода.
 */
export async function eventTime(
  eventId: number,
): Promise<{ at: Date; atPrecision: 'exact' | 'window' } | null> {
  const [row] = await db
    .select({ at: membershipEvents.at, atPrecision: membershipEvents.atPrecision })
    .from(membershipEvents)
    .where(eq(membershipEvents.id, eventId))
    .limit(1);
  if (!row) return null;
  return { at: row.at, atPrecision: row.atPrecision === 'window' ? 'window' : 'exact' };
}

export async function upsertUser(u: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}): Promise<void> {
  const displayName = [u.first_name, u.last_name].filter(Boolean).join(' ') || null;
  await db
    .insert(users)
    .values({ tgUserId: u.id, username: u.username ?? null, displayName })
    .onConflictDoUpdate({
      target: users.tgUserId,
      set: { username: u.username ?? null, displayName },
    });
}
