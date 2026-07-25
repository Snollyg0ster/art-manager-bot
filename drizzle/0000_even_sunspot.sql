CREATE TABLE "channels" (
	"chat_id" bigint PRIMARY KEY NOT NULL,
	"username" text,
	"title" text,
	"owner_user_id" bigint,
	"bot_is_admin" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"event" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"at_precision" text DEFAULT 'exact' NOT NULL,
	"observed_via" text NOT NULL,
	"update_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"chat_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"status" text NOT NULL,
	"since" timestamp with time zone,
	"last_event_id" bigint,
	"leave_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "memberships_chat_id_user_id_pk" PRIMARY KEY("chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "outbound_subs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_user_id" bigint NOT NULL,
	"chat_id" bigint NOT NULL,
	"label" text DEFAULT 'unlabeled' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text NOT NULL,
	"labeled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pairs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_user_id" bigint NOT NULL,
	"counterpart_user_id" bigint,
	"counterpart_chat_id" bigint NOT NULL,
	"state" text DEFAULT 'unresolved' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triage_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_user_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_channel_links" (
	"user_id" bigint NOT NULL,
	"chat_id" bigint NOT NULL,
	"confidence" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_channel_links_user_id_chat_id_pk" PRIMARY KEY("user_id","chat_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"tg_user_id" bigint PRIMARY KEY NOT NULL,
	"username" text,
	"display_name" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "membership_events_update_id_uq" ON "membership_events" USING btree ("update_id");--> statement-breakpoint
CREATE INDEX "membership_events_target_idx" ON "membership_events" USING btree ("chat_id","user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_subs_owner_chat_uq" ON "outbound_subs" USING btree ("owner_user_id","chat_id");--> statement-breakpoint
CREATE INDEX "outbound_subs_owner_label_idx" ON "outbound_subs" USING btree ("owner_user_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "pairs_owner_counterpart_chat_uq" ON "pairs" USING btree ("owner_user_id","counterpart_chat_id");--> statement-breakpoint
CREATE INDEX "pairs_owner_counterpart_user_idx" ON "pairs" USING btree ("owner_user_id","counterpart_user_id");--> statement-breakpoint
CREATE INDEX "triage_items_owner_state_idx" ON "triage_items" USING btree ("owner_user_id","state");