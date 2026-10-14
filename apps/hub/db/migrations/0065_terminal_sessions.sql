CREATE TYPE "hive"."terminal_mode" AS ENUM('propose', 'bypass');--> statement-breakpoint
CREATE TYPE "hive"."terminal_state" AS ENUM('opening', 'running', 'closed', 'failed');--> statement-breakpoint
CREATE TYPE "hive"."terminal_visibility" AS ENUM('private', 'team');--> statement-breakpoint
CREATE TABLE "hive"."terminal_chunks" (
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terminal_chunks_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
ALTER TABLE "hive"."terminal_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."terminal_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"mode" "hive"."terminal_mode" NOT NULL,
	"cli" text DEFAULT 'claude' NOT NULL,
	"model" text NOT NULL,
	"advisor" text,
	"account_id" text,
	"account_label" text,
	"permissions" text,
	"thread_id" uuid,
	"plan_id" uuid,
	"state" "hive"."terminal_state" DEFAULT 'opening' NOT NULL,
	"visibility" "hive"."terminal_visibility" DEFAULT 'private' NOT NULL,
	"cols" integer NOT NULL,
	"rows" integer NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"next_seq" integer DEFAULT 0 NOT NULL,
	"exit_code" integer,
	"end_reason" text,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "terminal_sessions_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."terminal_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."terminal_chunks" ADD CONSTRAINT "terminal_chunks_session_id_org_id_terminal_sessions_id_org_id_fk" FOREIGN KEY ("session_id","org_id") REFERENCES "hive"."terminal_sessions"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "terminal_chunks_org" ON "hive"."terminal_chunks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "terminal_sessions_owner" ON "hive"."terminal_sessions" USING btree ("org_id","owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "terminal_sessions_project" ON "hive"."terminal_sessions" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "terminal_sessions_machine_state" ON "hive"."terminal_sessions" USING btree ("machine_id","state");--> statement-breakpoint
CREATE POLICY "terminal_chunks_rw" ON "hive"."terminal_chunks" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "terminal_sessions_rw" ON "hive"."terminal_sessions" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
-- Viết tay: projects, machines, teams thuộc module khác, schema.ts của terminal không import được.
ALTER TABLE "hive"."terminal_sessions" ADD CONSTRAINT "terminal_sessions_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "hive"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."terminal_sessions" ADD CONSTRAINT "terminal_sessions_machine_id_org_id_machines_id_org_id_fk" FOREIGN KEY ("machine_id","org_id") REFERENCES "hive"."machines"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."terminal_sessions" ADD CONSTRAINT "terminal_sessions_team_id_org_id_teams_id_org_id_fk" FOREIGN KEY ("team_id","org_id") REFERENCES "hive"."teams"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE "hive"."terminal_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."terminal_chunks" FORCE ROW LEVEL SECURITY;
