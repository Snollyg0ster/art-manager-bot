import { InlineKeyboard } from 'grammy';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  membershipEvents, memberships, triageItems, users,
  type ChannelHint, type TriagePayload,
} from '../db/schema.js';

export type TriageItem = {
  id: number;
  payload: TriagePayload;
};

/** «12.03» — короткая дата, как в карточке RFC §8.2. */
function day(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}`;
}

function who(p: TriagePayload): string {
  const handle = p.username ? `@${p.username}` : null;
  if (handle && p.displayName) return `${handle} (${p.displayName})`;
  return handle ?? p.displayName ?? `id${p.userId}`;
}

export function channelLabel(hint: ChannelHint): string {
  if (hint.username) return `@${hint.username}`;
  return hint.title ?? `id${hint.chatId}`;
}

/**
 * RFC §8.2. Строка про повторные уходы — только при leaveCount > 1:
 * полная история уходов с датами подталкивает к мелочности.
 */
export function renderTriageCard(p: TriagePayload): string {
  const lines = [`👋 Отписался ${who(p)}`];

  if (p.leftAtPrecision === 'window') {
    // RFC §10: время обнаружения ≠ время ухода, выдавать одно за другое нельзя.
    lines.push(`   Ушёл между сверками, обнаружено ${day(p.leftAt)} — точное время неизвестно`);
  }

  lines.push(
    p.memberSince
      ? `   Был подписан с ${day(p.memberSince)}`
      : '   Был подписан до установки бота',
  );

  if (p.leaveCount > 1) {
    lines.push(`   Уходит не впервые: ${p.leaveCount}-й раз`);
  }

  if (p.awaitingChannel) {
    lines.push('', '   Пришли @handle его канала — проверю и запишу.');
    return lines.join('\n');
  }

  // RFC §8.3: уровень 'personal' идёт с пометкой «предположение» и требует
  // подтверждения — из профиля мог быть привязан любой канал.
  if (p.channelHint) {
    lines.push(`   Канал в его профиле: ${channelLabel(p.channelHint)} (предположение)`);
  }

  lines.push('', '   Это мью?');

  return lines.join('\n');
}

/**
 * Клавиатура карточки. С подсказкой §8.3 п.1 первая кнопка подтверждает
 * найденный канал, вторая оставляет путь на ручной ввод (§8.3 п.3).
 */
export function triageKeyboard(item: TriageItem): InlineKeyboard {
  const hint = item.payload.channelHint;
  const kb = new InlineKeyboard();

  if (hint) {
    kb.text(`Да, это ${channelLabel(hint)}`, `t:${item.id}:h`).row();
    kb.text('Да, но канал другой', `t:${item.id}:y`).row();
  } else {
    kb.text('Да, мью', `t:${item.id}:y`);
  }

  return kb.text('Нет', `t:${item.id}:n`).text('Не помню', `t:${item.id}:s`);
}

export type CreateLeaveTriageInput = {
  ownerUserId: number;
  chatId: number;
  userId: number;
  leftAt: Date;
  leftAtPrecision: 'exact' | 'window';
  /** RFC §8.3 п.1, если personal_chat нашёлся. */
  channelHint?: ChannelHint;
};

/**
 * Возвращает null, если по этому человеку уже висит открытая карточка:
 * второй уход подряд не должен плодить дубли в очереди разбора.
 */
export async function createLeaveTriage(
  input: CreateLeaveTriageInput,
): Promise<TriageItem | null> {
  const { ownerUserId, chatId, userId, leftAt, leftAtPrecision, channelHint } = input;

  const [dupe] = await db
    .select({ id: triageItems.id })
    .from(triageItems)
    .where(and(
      eq(triageItems.ownerUserId, ownerUserId),
      eq(triageItems.kind, 'left'),
      eq(triageItems.state, 'open'),
      sql`${triageItems.payload}->>'userId' = ${String(userId)}`,
    ))
    .limit(1);
  if (dupe) return null;

  const [u] = await db
    .select({ username: users.username, displayName: users.displayName })
    .from(users)
    .where(eq(users.tgUserId, userId))
    .limit(1);

  const [m] = await db
    .select({ leaveCount: memberships.leaveCount })
    .from(memberships)
    .where(and(eq(memberships.chatId, chatId), eq(memberships.userId, userId)))
    .limit(1);

  // memberships.since после ухода указывает на сам уход, поэтому дату подписки
  // берём из лога. Её нет, если человек зашёл до установки бота — RFC §15.
  const [joined] = await db
    .select({ at: membershipEvents.at })
    .from(membershipEvents)
    .where(and(
      eq(membershipEvents.chatId, chatId),
      eq(membershipEvents.userId, userId),
      sql`${membershipEvents.event} in ('join', 'unban')`,
    ))
    .orderBy(desc(membershipEvents.at), desc(membershipEvents.id))
    .limit(1);

  const payload: TriagePayload = {
    chatId,
    userId,
    username: u?.username ?? null,
    displayName: u?.displayName ?? null,
    leftAt: leftAt.toISOString(),
    leftAtPrecision,
    memberSince: joined?.at.toISOString() ?? null,
    leaveCount: m?.leaveCount ?? 1,
    ...(channelHint ? { channelHint } : {}),
  };

  const [row] = await db
    .insert(triageItems)
    .values({ ownerUserId, kind: 'left', payload, state: 'open' })
    .returning({ id: triageItems.id });

  return row ? { id: row.id, payload } : null;
}

/**
 * Только карточки ухода: рядом в таблице живут kind='joined' (новые подписчики),
 * и в ветку §8.2 они попадать не должны. Отсюда же cast payload — форма
 * гарантирована условием по kind.
 */
export async function openTriageItems(ownerUserId: number): Promise<TriageItem[]> {
  const rows = await db
    .select({ id: triageItems.id, payload: triageItems.payload })
    .from(triageItems)
    .where(and(
      eq(triageItems.ownerUserId, ownerUserId),
      eq(triageItems.kind, 'left'),
      eq(triageItems.state, 'open'),
    ))
    .orderBy(asc(triageItems.id));
  return rows.map((r) => ({ id: r.id, payload: r.payload as TriagePayload }));
}

export async function getTriageItem(
  itemId: number,
  ownerUserId: number,
): Promise<TriageItem | null> {
  const [row] = await db
    .select({ id: triageItems.id, payload: triageItems.payload })
    .from(triageItems)
    .where(and(
      eq(triageItems.id, itemId),
      eq(triageItems.ownerUserId, ownerUserId),
      eq(triageItems.kind, 'left'),
    ))
    .limit(1);
  return row ? { id: row.id, payload: row.payload as TriagePayload } : null;
}

/**
 * RFC-отступление: «жду @handle» живёт в payload карточки, а не в отдельной FSM —
 * на одну ветку диалога conversations избыточен.
 */
export async function setAwaitingChannel(itemId: number, awaiting: boolean): Promise<void> {
  await db
    .update(triageItems)
    .set({
      payload: sql`jsonb_set(${triageItems.payload}, '{awaitingChannel}', ${awaiting ? 'true' : 'false'}::jsonb)`,
    })
    .where(eq(triageItems.id, itemId));
}

/** Последняя карточка, по которой ждём @handle от владельца. */
export async function awaitingChannelItem(ownerUserId: number): Promise<TriageItem | null> {
  const [row] = await db
    .select({ id: triageItems.id, payload: triageItems.payload })
    .from(triageItems)
    .where(and(
      eq(triageItems.ownerUserId, ownerUserId),
      eq(triageItems.kind, 'left'),
      eq(triageItems.state, 'open'),
      sql`${triageItems.payload}->>'awaitingChannel' = 'true'`,
    ))
    .orderBy(desc(triageItems.id))
    .limit(1);
  return row ? { id: row.id, payload: row.payload as TriagePayload } : null;
}

export async function setTriageState(
  itemId: number,
  ownerUserId: number,
  state: 'resolved' | 'dismissed',
): Promise<void> {
  await db
    .update(triageItems)
    .set({ state })
    .where(and(eq(triageItems.id, itemId), eq(triageItems.ownerUserId, ownerUserId)));
}
