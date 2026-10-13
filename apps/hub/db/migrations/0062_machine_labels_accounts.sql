ALTER TABLE "hive"."machines" ADD COLUMN "labels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."machines" ADD COLUMN "labels_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."machines" ADD COLUMN "accounts" jsonb;--> statement-breakpoint
ALTER TABLE "hive"."machines" ADD COLUMN "accounts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hive"."registration_tokens" ADD COLUMN "labels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."registration_tokens" ADD COLUMN "shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."registration_tokens" ADD COLUMN "labels_only" boolean DEFAULT false NOT NULL;