CREATE TYPE "hive"."run_kind" AS ENUM('code', 'review');--> statement-breakpoint
CREATE TYPE "hive"."run_state" AS ENUM('queued', 'planning', 'awaiting_plan', 'leased', 'preparing', 'running', 'awaiting_input', 'verifying', 'succeeded', 'no_changes', 'needs_review', 'failed', 'lost', 'cancelling', 'cancelled');--> statement-breakpoint
CREATE TYPE "hive"."task_status" AS ENUM('todo', 'queued', 'running', 'review', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "hive"."run_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hive"."run_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"seq" integer,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_seq" UNIQUE("run_id","attempt","seq")
);
--> statement-breakpoint
ALTER TABLE "hive"."run_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."run_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"machine_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_leases_run" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."run_leases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."run_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hive"."run_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"seq" integer NOT NULL,
	"offset" bigint NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_logs_offset" UNIQUE("run_id","attempt","offset")
);
--> statement-breakpoint
ALTER TABLE "hive"."run_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "hive"."run_kind" DEFAULT 'code' NOT NULL,
	"state" "hive"."run_state" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"machine_id" uuid,
	"pinned_machine_id" uuid,
	"cli" text,
	"branch" text NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"result" jsonb,
	"head_sha" text,
	"pr_url" text,
	"timeout_sec" integer DEFAULT 3600 NOT NULL,
	"offer_machine_id" uuid,
	"offer_expires_at" timestamp with time zone,
	"rejected_by" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"type" text,
	"status" "hive"."task_status" DEFAULT 'todo' NOT NULL,
	"preferred_cli" text,
	"created_by" text NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_project_number" UNIQUE("project_id","number"),
	CONSTRAINT "tasks_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."run_events" ADD CONSTRAINT "run_events_run_id_org_id_runs_id_org_id_fk" FOREIGN KEY ("run_id","org_id") REFERENCES "hive"."runs"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."run_leases" ADD CONSTRAINT "run_leases_run_id_org_id_runs_id_org_id_fk" FOREIGN KEY ("run_id","org_id") REFERENCES "hive"."runs"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."run_logs" ADD CONSTRAINT "run_logs_run_id_org_id_runs_id_org_id_fk" FOREIGN KEY ("run_id","org_id") REFERENCES "hive"."runs"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_events_run" ON "hive"."run_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "run_events_org" ON "hive"."run_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "run_leases_machine" ON "hive"."run_leases" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "run_leases_org_team" ON "hive"."run_leases" USING btree ("org_id","team_id");--> statement-breakpoint
CREATE INDEX "run_logs_run" ON "hive"."run_logs" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "run_logs_org" ON "hive"."run_logs" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_task_active" ON "hive"."runs" USING btree ("task_id") WHERE state not in ('succeeded', 'no_changes', 'needs_review', 'failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "runs_org_team" ON "hive"."runs" USING btree ("org_id","team_id");--> statement-breakpoint
CREATE INDEX "runs_team_state" ON "hive"."runs" USING btree ("team_id","state");--> statement-breakpoint
CREATE INDEX "runs_task" ON "hive"."runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tasks_org_team" ON "hive"."tasks" USING btree ("org_id","team_id");--> statement-breakpoint
CREATE INDEX "tasks_project_status" ON "hive"."tasks" USING btree ("project_id","status");--> statement-breakpoint
CREATE POLICY "run_events_select" ON "hive"."run_events" AS PERMISSIVE FOR SELECT TO "hive_app" USING (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "run_events_insert" ON "hive"."run_events" AS PERMISSIVE FOR INSERT TO "hive_app" WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "run_leases_rw" ON "hive"."run_leases" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "run_logs_rw" ON "hive"."run_logs" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "runs_rw" ON "hive"."runs" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "tasks_rw" ON "hive"."tasks" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());