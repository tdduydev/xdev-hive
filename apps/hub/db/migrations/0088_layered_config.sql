CREATE TABLE "hive"."config_layer_entries" (
	"org_id" uuid DEFAULT hive.ctx_org() NOT NULL,
	"layer" text NOT NULL,
	"target_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"locked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_layer_entries_org_id_layer_target_id_key_pk" PRIMARY KEY("org_id","layer","target_id","key"),
	CONSTRAINT "config_layer_entries_layer" CHECK (layer in ('org', 'project'))
);
--> statement-breakpoint
ALTER TABLE "hive"."config_layer_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "config_layer_entries_rw" ON "hive"."config_layer_entries" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());
--> statement-breakpoint
ALTER TABLE "hive"."config_layer_entries" FORCE ROW LEVEL SECURITY;