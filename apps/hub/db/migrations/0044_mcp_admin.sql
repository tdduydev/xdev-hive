CREATE TABLE "hive"."mcp_tool_overrides" (
	"org_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tool_overrides_org_id_tool_name_pk" PRIMARY KEY("org_id","tool_name")
);
--> statement-breakpoint
ALTER TABLE "hive"."mcp_tool_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."mcp_user_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"client_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_user_tokens_initial_expiry" CHECK ("hive"."mcp_user_tokens"."expires_at" > "hive"."mcp_user_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "hive"."mcp_user_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_user_tokens_hash" ON "hive"."mcp_user_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_user_tokens_org_user" ON "hive"."mcp_user_tokens" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE POLICY "mcp_tool_overrides_rw" ON "hive"."mcp_tool_overrides" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "mcp_user_tokens_rw" ON "hive"."mcp_user_tokens" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
ALTER TABLE "hive"."mcp_tool_overrides" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."mcp_user_tokens" FORCE ROW LEVEL SECURITY;
