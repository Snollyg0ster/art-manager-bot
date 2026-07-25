import { and, asc, count, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channels, outboundSubs, pairs } from '../db/schema.js';
import { openTriageItems } from './triage.js';

export type ReportChannel = {
  pairId: number;
  chatId: number;
  username: string | null;
  title: string | null;
  changedAt: Date;
};

export type Report = {
  broken: ReportChannel[];
  returned: ReportChannel[];
  triage: Array<{ id: number; who: string; leftAt: string }>;
  unlabeled: number;
  mutual: number;
  total: number;
};

function channelsInState(ownerUserId: number, state: 'broken' | 'returned') {
  return db
    .select({
      pairId: pairs.id,
      chatId: pairs.counterpartChatId,
      username: channels.username,
      title: channels.title,
      changedAt: pairs.stateChangedAt,
    })
    .from(pairs)
    .leftJoin(channels, eq(channels.chatId, pairs.counterpartChatId))
    .where(and(eq(pairs.ownerUserId, ownerUserId), eq(pairs.state, state)))
    .orderBy(asc(pairs.stateChangedAt));
}

export async function buildReport(ownerUserId: number): Promise<Report> {
  const [broken, returned, triage, stats] = await Promise.all([
    channelsInState(ownerUserId, 'broken'),
    channelsInState(ownerUserId, 'returned'),
    openTriageItems(ownerUserId),
    db
      .select({
        total: count(),
        unlabeled: sql<number>`count(*) filter (where ${outboundSubs.label} = 'unlabeled')`
          .mapWith(Number),
        mutual: sql<number>`count(*) filter (where ${outboundSubs.label} = 'mutual')`
          .mapWith(Number),
      })
      .from(outboundSubs)
      .where(and(
        eq(outboundSubs.ownerUserId, ownerUserId),
        eq(outboundSubs.status, 'active'),
      )),
  ]);

  return {
    broken,
    returned,
    triage: triage
      .filter((i) => !i.payload.awaitingChannel)
      .map((i) => ({
        id: i.id,
        who: i.payload.username ? `@${i.payload.username}` : (i.payload.displayName ?? `id${i.payload.userId}`),
        leftAt: i.payload.leftAt,
      })),
    unlabeled: stats[0]?.unlabeled ?? 0,
    mutual: stats[0]?.mutual ?? 0,
    total: stats[0]?.total ?? 0,
  };
}

function handleOf(c: ReportChannel): string {
  if (c.username) return `@${c.username}`;
  return c.title ?? `id${c.chatId}`;
}

function ago(at: Date | string): string {
  const ms = Date.now() - new Date(at).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  return `${days} дн. назад`;
}

/**
 * RFC §9. Порядок разделов фиксирован: сначала то, что требует действия.
 * Цифра «не размечено» показывается честно — её сокращение и есть
 * единственный внятный показатель прогресса для владельца.
 */
export function renderReport(r: Report): string {
  const blocks: string[] = [];

  if (r.broken.length > 0) {
    blocks.push([
      `❌ Отписались от тебя (${r.broken.length})`,
      ...r.broken.map((c) => {
        const link = c.username ? `\n   t.me/${c.username}` : '';
        return `   ${handleOf(c)} — ушёл ${ago(c.changedAt)}, ты подписан${link}`;
      }),
      '   Отписаться нужно руками, потом жми «Отписался, готово».',
    ].join('\n'));
  }

  if (r.triage.length > 0) {
    blocks.push([
      `📥 Требуют разбора (${r.triage.length})`,
      ...r.triage.map((t) => `   ${t.who} ушёл ${ago(t.leftAt)} — это было мью?`),
      '   /triage — разобрать.',
    ].join('\n'));
  }

  blocks.push(
    r.total === 0
      ? '🔍 Подписок пока нет — /import загрузит список.'
      : `🔍 Не размечено (${r.unlabeled} из ${r.total} подписок)\n   /label — разметить.`,
  );

  blocks.push(`✅ Взаимно (${r.mutual})`);

  if (r.returned.length > 0) {
    // RFC §7.1: returned нужен ровно затем, чтобы не дать отписаться
    // от того, кто уже вернулся.
    blocks.push([
      `↩️ Ушли и вернулись (${r.returned.length})`,
      ...r.returned.map((c) => `   ${handleOf(c)} — из списка на отписку убран`),
    ].join('\n'));
  }

  return blocks.join('\n\n');
}
