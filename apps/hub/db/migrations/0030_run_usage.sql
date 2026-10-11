ALTER TABLE "hive"."runs" ADD COLUMN "tokens_in" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."runs" ADD COLUMN "tokens_out" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."runs" ADD COLUMN "cache_read" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."runs" ADD COLUMN "cache_write" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."runs" ADD COLUMN "cost_usd" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "hive"."runs" ADD COLUMN "turns" integer;--> statement-breakpoint
CREATE INDEX "runs_project_created" ON "hive"."runs" USING btree ("project_id","created_at");