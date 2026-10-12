ALTER TABLE "hive"."machines" ADD COLUMN "shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."runs" ADD COLUMN "owner_user_id" text;