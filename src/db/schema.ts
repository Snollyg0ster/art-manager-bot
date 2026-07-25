import {
  pgTable, bigint, bigserial, text, timestamp, integer, boolean,
  jsonb, primaryKey, uniqueIndex, index,
} from 'drizzle-orm/pg-core';

/** Telegram ID помещаются в 52 бита, mode:'number' безопасен. */
const tgId = (name: string) => bigint(name, { mode: 'number' });

export const users = pgTable('users', {
  tgUserId: tgId('tg_user_id').primaryKey(),
  username: text('username'),
  displayName: text('display_name'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export const channels = pgTable('channels', {
  chatId: tgId('chat_id').primaryKey(),
  username: text('username'),
  title: text('title'),
  ownerUserId: tgId('owner_user_id'),
  botIsAdmin: boolean('bot_is_admin').notNull().default(false),
});

/** RFC §7, ось 3. confidence: 'owner' | 'manual' | 'personal' | 'guess' */
export const userChannelLinks = pgTable('user_channel_links', {
  userId: tgId('user_id').notNull(),
  chatId: tgId('chat_id').notNull(),
  confidence: text('confidence').notNull(),
  source: text('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.chatId] }),
}));

/** RFC §7, ось 1. label: 'mutual' | 'not_mutual' | 'unlabeled' */
export const outboundSubs = pgTable('outbound_subs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ownerUserId: tgId('owner_user_id').notNull(),
  chatId: tgId('chat_id').notNull(),
  label: text('label').notNull().default('unlabeled'),
  status: text('status').notNull().default('active'),
  source: text('source').notNull(),
  labeledAt: timestamp('labeled_at', { withTimezone: true }),
}, (t) => ({
  uq: uniqueIndex('outbound_subs_owner_chat_uq').on(t.ownerUserId, t.chatId),
  byLabel: index('outbound_subs_owner_label_idx').on(t.ownerUserId, t.label),
}));

/**
 * RFC §7.2, ось 2, источник истины. Append-only.
 * updateId nullable и unique: Postgres допускает много NULL в unique-индексе,
 * поэтому reconcile-события (без update_id) не конфликтуют между собой,
 * а ретраи вебхука с одинаковым update_id — отсекаются.
 */
export const membershipEvents = pgTable('membership_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  chatId: tgId('chat_id').notNull(),
  userId: tgId('user_id').notNull(),
  event: text('event').notNull(),           // join | leave | kick | unban
  at: timestamp('at', { withTimezone: true }).notNull(),
  atPrecision: text('at_precision').notNull().default('exact'), // exact | window
  observedVia: text('observed_via').notNull(),                  // chat_member | reconcile | export
  updateId: bigint('update_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqUpdate: uniqueIndex('membership_events_update_id_uq').on(t.updateId),
  byTarget: index('membership_events_target_idx').on(t.chatId, t.userId, t.id),
}));

/** RFC §7.2: проекция, пересобираемая из лога. */
export const memberships = pgTable('memberships', {
  chatId: tgId('chat_id').notNull(),
  userId: tgId('user_id').notNull(),
  status: text('status').notNull(),         // member | left | kicked
  since: timestamp('since', { withTimezone: true }),
  lastEventId: bigint('last_event_id', { mode: 'number' }),
  leaveCount: integer('leave_count').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.chatId, t.userId] }),
}));

/** RFC §7.1. state: watching | broken | returned | unresolved | closed */
export const pairs = pgTable('pairs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ownerUserId: tgId('owner_user_id').notNull(),
  counterpartUserId: tgId('counterpart_user_id'),   // nullable по RFC §7
  counterpartChatId: tgId('counterpart_chat_id').notNull(),
  state: text('state').notNull().default('unresolved'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  stateChangedAt: timestamp('state_changed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uq: uniqueIndex('pairs_owner_counterpart_chat_uq').on(t.ownerUserId, t.counterpartChatId),
  byUser: index('pairs_owner_counterpart_user_idx').on(t.ownerUserId, t.counterpartUserId),
}));

/** RFC §7. kind: 'left'. state: open | resolved | dismissed */
export const triageItems = pgTable('triage_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ownerUserId: tgId('owner_user_id').notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').$type<TriagePayload>().notNull(),
  state: text('state').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOwner: index('triage_items_owner_state_idx').on(t.ownerUserId, t.state),
}));

export type TriagePayload = {
  chatId: number;
  userId: number;
  username: string | null;
  displayName: string | null;
  leftAt: string;
  leftAtPrecision: 'exact' | 'window';
  memberSince: string | null;
  leaveCount: number;
  /** true, пока ждём от владельца @handle канала контрагента */
  awaitingChannel?: boolean;
};
