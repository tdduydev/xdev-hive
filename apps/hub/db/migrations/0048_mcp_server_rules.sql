CREATE TABLE "hive"."mcp_server_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"rule" text NOT NULL,
	"match_type" text NOT NULL,
	"pattern" text NOT NULL,
	"transport" text,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"url" text,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_rules_rule" CHECK ("hive"."mcp_server_rules"."rule" in ('allow', 'deny')),
	CONSTRAINT "mcp_server_rules_match_type" CHECK ("hive"."mcp_server_rules"."match_type" in ('name', 'url', 'command', 'wildcard')),
	CONSTRAINT "mcp_server_rules_launch" CHECK (("hive"."mcp_server_rules"."transport" is null and "hive"."mcp_server_rules"."command" is null and "hive"."mcp_server_rules"."url" is null)
          or ("hive"."mcp_server_rules"."transport" = 'stdio' and "hive"."mcp_server_rules"."command" is not null and "hive"."mcp_server_rules"."url" is null)
          or ("hive"."mcp_server_rules"."transport" = 'http' and "hive"."mcp_server_rules"."url" is not null and "hive"."mcp_server_rules"."command" is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."mcp_server_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "mcp_server_rules_org_project" ON "hive"."mcp_server_rules" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE POLICY "mcp_server_rules_rw" ON "hive"."mcp_server_rules" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
ALTER TABLE "hive"."mcp_server_rules" FORCE ROW LEVEL SECURITY;
