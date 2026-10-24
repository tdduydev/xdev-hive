CREATE TABLE "hive"."qa_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"doc_id" uuid,
	"doc_key" text NOT NULL,
	"parsed_version" integer,
	"parse_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"errors_version" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_areas_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "qa_areas_project_code" UNIQUE("project_id","code"),
	CONSTRAINT "qa_areas_code" CHECK (code ~ '^[A-Z][A-Z0-9]{1,15}$'),
	CONSTRAINT "qa_areas_parse_errors" CHECK (case when jsonb_typeof(parse_errors) = 'array' then jsonb_array_length(parse_errors) between 0 and 100
    else false end)
);
--> statement-breakpoint
ALTER TABLE "hive"."qa_areas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."qa_case_status" (
	"case_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"ci_status" text,
	"ci_at" timestamp with time zone,
	"ci_run_id" uuid,
	"manual_status" text,
	"manual_at" timestamp with time zone,
	"manual_round_case_id" uuid,
	"current_status" text GENERATED ALWAYS AS (case when manual_status is not null and (ci_status is null or ci_at <= manual_at) then manual_status else ci_status end) STORED,
	"current_source" text GENERATED ALWAYS AS (case when manual_status is not null and (ci_status is null or ci_at <= manual_at) then 'manual' when ci_status is not null then 'ci' end) STORED,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_case_status_ci" CHECK (ci_status is null or ci_status in ('passed', 'flaky', 'failed', 'skipped')),
	CONSTRAINT "qa_case_status_manual" CHECK (manual_status is null or manual_status in ('passed', 'failed', 'other')),
	CONSTRAINT "qa_case_status_ci_at" CHECK ((ci_status is null) = (ci_at is null)),
	CONSTRAINT "qa_case_status_manual_at" CHECK ((manual_status is null) = (manual_at is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."qa_case_status" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."qa_case_versions" (
	"case_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"org_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"doc_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_case_versions_case_id_version_pk" PRIMARY KEY("case_id","version")
);
--> statement-breakpoint
ALTER TABLE "hive"."qa_case_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."qa_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"priority" text NOT NULL,
	"kind" text NOT NULL,
	"requirements" text[] NOT NULL,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"preconditions" text,
	"steps" jsonb NOT NULL,
	"test_data" text,
	"script" text,
	"note" text,
	"line" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_cases_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "qa_cases_project_code" UNIQUE("project_id","code"),
	CONSTRAINT "qa_cases_code" CHECK (code ~ '^TC-[A-Z][A-Z0-9]{1,15}-[0-9]{3,5}$'),
	CONSTRAINT "qa_cases_name" CHECK (char_length(name) between 1 and 300),
	CONSTRAINT "qa_cases_priority" CHECK (priority in ('P1', 'P2', 'P3')),
	CONSTRAINT "qa_cases_kind" CHECK (kind in ('automated', 'manual', 'planned')),
	CONSTRAINT "qa_cases_requirements" CHECK (cardinality(requirements) >= 1 and array_to_string(requirements, ',') ~ '^((\d{3}/)?(FR|AC|NFR|US)-\d{3,4}(\.\d+)?|(?!(FR|AC|NFR|US)(\d|,|$))[A-Z][A-Z0-9]{2,15})(,((\d{3}/)?(FR|AC|NFR|US)-\d{3,4}(\.\d+)?|(?!(FR|AC|NFR|US)(\d|,|$))[A-Z][A-Z0-9]{2,15}))*$'),
	CONSTRAINT "qa_cases_labels" CHECK (cardinality(labels) <= 20 and array_to_string(labels, ',') !~ '\s'),
	CONSTRAINT "qa_cases_steps" CHECK (case when jsonb_typeof(steps) = 'array' then jsonb_array_length(steps) between 1 and 1000
    else false end),
	CONSTRAINT "qa_cases_script" CHECK (kind <> 'automated' or script is not null),
	CONSTRAINT "qa_cases_version" CHECK (version >= 1),
	CONSTRAINT "qa_cases_state" CHECK (state in ('active', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "hive"."qa_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."qa_ci_run_cases" (
	"run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"status" text NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"worst_job_id" bigint,
	CONSTRAINT "qa_ci_run_cases_run_id_case_id_pk" PRIMARY KEY("run_id","case_id"),
	CONSTRAINT "qa_ci_run_cases_status" CHECK (status in ('passed', 'flaky', 'failed', 'skipped')),
	CONSTRAINT "qa_ci_run_cases_numbers" CHECK (retries >= 0 and duration_ms >= 0)
);
--> statement-breakpoint
ALTER TABLE "hive"."qa_ci_run_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."qa_ci_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"pipeline_id" bigint NOT NULL,
	"read_state" text DEFAULT 'waiting' NOT NULL,
	"delivery_job_id" uuid,
	"read_attempts" integer DEFAULT 0 NOT NULL,
	"waiting_since" timestamp with time zone,
	"wait_reason" text,
	"read_error_code" text,
	"pipeline_status" text NOT NULL,
	"ref" text NOT NULL,
	"sha" text NOT NULL,
	"kind" text NOT NULL,
	"is_reference" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"job_ids" bigint[] DEFAULT '{}' NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"flaky" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"unmapped" integer DEFAULT 0 NOT NULL,
	"ambiguous" integer DEFAULT 0 NOT NULL,
	"unknown_codes" text[] DEFAULT '{}' NOT NULL,
	"retired_codes" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_ci_runs_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "qa_ci_runs_source_pipeline" UNIQUE("source_id","pipeline_id"),
	CONSTRAINT "qa_ci_runs_read_state" CHECK (read_state in ('waiting', 'reading', 'done', 'no-report', 'error', 'expired')),
	CONSTRAINT "qa_ci_runs_read_attempts" CHECK (read_attempts >= 0),
	CONSTRAINT "qa_ci_runs_pipeline_status" CHECK (pipeline_status in ('success', 'failed', 'canceled', 'skipped', 'manual')),
	CONSTRAINT "qa_ci_runs_sha" CHECK (sha ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "qa_ci_runs_kind" CHECK (kind in ('branch', 'mr')),
	CONSTRAINT "qa_ci_runs_unknown_codes" CHECK (cardinality(unknown_codes) <= 200),
	CONSTRAINT "qa_ci_runs_counts" CHECK (passed >= 0 and flaky >= 0 and failed >= 0 and skipped >= 0 and unmapped >= 0 and ambiguous >= 0
          and retired_codes >= 0)
);
--> statement-breakpoint
ALTER TABLE "hive"."qa_ci_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."qa_ci_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"label" text NOT NULL,
	"repo_path" text NOT NULL,
	"repo_web_url" text NOT NULL,
	"branch_filter" text[] DEFAULT '{}' NOT NULL,
	"job_filter" text[] DEFAULT '{}' NOT NULL,
	"mode" text NOT NULL,
	"artifact_path" text,
	"reference_branch" text NOT NULL,
	"credential" text NOT NULL,
	"backfill_state" text DEFAULT 'pending' NOT NULL,
	"refetch_requested_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_ci_sources_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "qa_ci_sources_project_label" UNIQUE("project_id","label"),
	CONSTRAINT "qa_ci_sources_label" CHECK (char_length(label) between 1 and 80),
	CONSTRAINT "qa_ci_sources_repo_web_url" CHECK (repo_web_url ~ '^https://'),
	CONSTRAINT "qa_ci_sources_mode" CHECK (mode in ('pipeline-report', 'junit-artifact', 'playwright-artifact')),
	CONSTRAINT "qa_ci_sources_artifact_path" CHECK ((mode = 'pipeline-report' or artifact_path is not null)
          and (artifact_path is null or (char_length(artifact_path) >= 1 and artifact_path !~ '^/' and artifact_path !~ '(^|/)\.\.(/|$)'))),
	CONSTRAINT "qa_ci_sources_backfill_state" CHECK (backfill_state in ('pending', 'listing', 'done', 'error'))
);
--> statement-breakpoint
ALTER TABLE "hive"."qa_ci_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."qa_project_settings" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"tc_dir" text DEFAULT 'test-cases/' NOT NULL,
	"include_result" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_project_settings_tc_dir" CHECK (char_length(tc_dir) between 1 and 200 and tc_dir ~ '/$' and tc_dir !~ '^/' and tc_dir !~ '(^|/)\.\.(/|$)'),
	CONSTRAINT "qa_project_settings_include_result" CHECK (include_result is null or include_result in ('no-home', 'covered', 'added'))
);
--> statement-breakpoint
ALTER TABLE "hive"."qa_project_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."qa_result_history" (
	"round_case_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"org_id" uuid NOT NULL,
	"status" text NOT NULL,
	"failed_step" integer,
	"note" text,
	"links" text[] DEFAULT '{}' NOT NULL,
	"recorded_by" text,
	"recorded_at" timestamp with time zone,
	"recorded_case_version" integer,
	"note_deleted" boolean DEFAULT false NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_result_history_round_case_id_revision_pk" PRIMARY KEY("round_case_id","revision"),
	CONSTRAINT "qa_result_history_status" CHECK (status in ('passed', 'failed', 'untested', 'not-applicable', 'deferred', 'other')),
	CONSTRAINT "qa_result_history_note_deleted" CHECK (not note_deleted or note is null)
);
--> statement-breakpoint
ALTER TABLE "hive"."qa_result_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."qa_round_assignees" (
	"round_case_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"assigned_by" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_round_assignees_round_case_id_user_id_pk" PRIMARY KEY("round_case_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."qa_round_assignees" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."qa_round_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"case_version_at_add" integer NOT NULL,
	"status" text DEFAULT 'untested' NOT NULL,
	"failed_step" integer,
	"note" text,
	"links" text[] DEFAULT '{}' NOT NULL,
	"recorded_by" text,
	"recorded_at" timestamp with time zone,
	"recorded_case_version" integer,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "qa_round_cases_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "qa_round_cases_round_case" UNIQUE("round_id","case_id"),
	CONSTRAINT "qa_round_cases_status" CHECK (status in ('passed', 'failed', 'untested', 'not-applicable', 'deferred', 'other')),
	CONSTRAINT "qa_round_cases_failed_step" CHECK (failed_step is null or failed_step >= 1),
	CONSTRAINT "qa_round_cases_note" CHECK (note is null or char_length(note) <= 500),
	CONSTRAINT "qa_round_cases_links" CHECK (cardinality(links) <= 5 and (cardinality(links) < 1 or (links[1] ~* '^https?://\S+$' and char_length(links[1]) <= 2000)) and (cardinality(links) < 2 or (links[2] ~* '^https?://\S+$' and char_length(links[2]) <= 2000)) and (cardinality(links) < 3 or (links[3] ~* '^https?://\S+$' and char_length(links[3]) <= 2000)) and (cardinality(links) < 4 or (links[4] ~* '^https?://\S+$' and char_length(links[4]) <= 2000)) and (cardinality(links) < 5 or (links[5] ~* '^https?://\S+$' and char_length(links[5]) <= 2000))),
	CONSTRAINT "qa_round_cases_explained" CHECK (status not in ('other', 'failed') or coalesce(char_length(note), 0) > 0 or cardinality(links) > 0),
	CONSTRAINT "qa_round_cases_revision" CHECK (revision >= 0)
);
--> statement-breakpoint
ALTER TABLE "hive"."qa_round_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."qa_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"environment" text DEFAULT '' NOT NULL,
	"build" text DEFAULT '' NOT NULL,
	"start_date" date NOT NULL,
	"planned_end_date" date NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"previous_round_id" uuid,
	"reopen_reason" text,
	"open_recording" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_rounds_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "qa_rounds_name" CHECK (char_length(name) between 1 and 120),
	CONSTRAINT "qa_rounds_environment" CHECK (char_length(environment) <= 80),
	CONSTRAINT "qa_rounds_build" CHECK (char_length(build) <= 80),
	CONSTRAINT "qa_rounds_dates" CHECK (planned_end_date >= start_date),
	CONSTRAINT "qa_rounds_state" CHECK (state in ('open', 'closed')),
	CONSTRAINT "qa_rounds_reopen_reason" CHECK (reopen_reason is null or char_length(reopen_reason) between 10 and 500)
);
--> statement-breakpoint
ALTER TABLE "hive"."qa_rounds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."qa_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"retention_days" integer DEFAULT 365 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_settings_retention_days" CHECK ("hive"."qa_settings"."retention_days" BETWEEN 90 AND 3650)
);
--> statement-breakpoint
ALTER TABLE "hive"."qa_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."qa_case_status" ADD CONSTRAINT "qa_case_status_case_id_org_id_qa_cases_id_org_id_fk" FOREIGN KEY ("case_id","org_id") REFERENCES "hive"."qa_cases"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."qa_case_versions" ADD CONSTRAINT "qa_case_versions_case_id_org_id_qa_cases_id_org_id_fk" FOREIGN KEY ("case_id","org_id") REFERENCES "hive"."qa_cases"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."qa_cases" ADD CONSTRAINT "qa_cases_area_id_org_id_qa_areas_id_org_id_fk" FOREIGN KEY ("area_id","org_id") REFERENCES "hive"."qa_areas"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."qa_ci_run_cases" ADD CONSTRAINT "qa_ci_run_cases_run_id_org_id_qa_ci_runs_id_org_id_fk" FOREIGN KEY ("run_id","org_id") REFERENCES "hive"."qa_ci_runs"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."qa_ci_run_cases" ADD CONSTRAINT "qa_ci_run_cases_case_id_org_id_qa_cases_id_org_id_fk" FOREIGN KEY ("case_id","org_id") REFERENCES "hive"."qa_cases"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."qa_ci_runs" ADD CONSTRAINT "qa_ci_runs_source_id_org_id_qa_ci_sources_id_org_id_fk" FOREIGN KEY ("source_id","org_id") REFERENCES "hive"."qa_ci_sources"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."qa_result_history" ADD CONSTRAINT "qa_result_history_round_case_id_org_id_qa_round_cases_id_org_id_fk" FOREIGN KEY ("round_case_id","org_id") REFERENCES "hive"."qa_round_cases"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."qa_round_assignees" ADD CONSTRAINT "qa_round_assignees_round_case_id_org_id_qa_round_cases_id_org_id_fk" FOREIGN KEY ("round_case_id","org_id") REFERENCES "hive"."qa_round_cases"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."qa_round_cases" ADD CONSTRAINT "qa_round_cases_round_id_org_id_qa_rounds_id_org_id_fk" FOREIGN KEY ("round_id","org_id") REFERENCES "hive"."qa_rounds"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."qa_round_cases" ADD CONSTRAINT "qa_round_cases_case_id_org_id_qa_cases_id_org_id_fk" FOREIGN KEY ("case_id","org_id") REFERENCES "hive"."qa_cases"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qa_areas_doc" ON "hive"."qa_areas" USING btree ("doc_id") WHERE doc_id is not null;--> statement-breakpoint
CREATE INDEX "qa_case_status_project_current" ON "hive"."qa_case_status" USING btree ("project_id","current_status");--> statement-breakpoint
CREATE INDEX "qa_case_status_project_area" ON "hive"."qa_case_status" USING btree ("project_id","area_id");--> statement-breakpoint
CREATE INDEX "qa_cases_project_area_state" ON "hive"."qa_cases" USING btree ("project_id","area_id","state");--> statement-breakpoint
CREATE INDEX "qa_cases_requirements" ON "hive"."qa_cases" USING gin ("requirements");--> statement-breakpoint
CREATE INDEX "qa_cases_labels" ON "hive"."qa_cases" USING gin ("labels");--> statement-breakpoint
CREATE INDEX "qa_ci_run_cases_case_run" ON "hive"."qa_ci_run_cases" USING btree ("case_id","run_id");--> statement-breakpoint
CREATE INDEX "qa_ci_runs_source_reference" ON "hive"."qa_ci_runs" USING btree ("source_id","is_reference","finished_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "qa_ci_runs_org_read_state" ON "hive"."qa_ci_runs" USING btree ("org_id","read_state");--> statement-breakpoint
CREATE INDEX "qa_ci_sources_project_repo" ON "hive"."qa_ci_sources" USING btree ("project_id","repo_path");--> statement-breakpoint
CREATE INDEX "qa_round_assignees_user" ON "hive"."qa_round_assignees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "qa_round_cases_case_recorded" ON "hive"."qa_round_cases" USING btree ("case_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "qa_rounds_project_state" ON "hive"."qa_rounds" USING btree ("project_id","state");--> statement-breakpoint
CREATE POLICY "qa_areas_rw" ON "hive"."qa_areas" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_case_status_rw" ON "hive"."qa_case_status" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_case_versions_rw" ON "hive"."qa_case_versions" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_cases_rw" ON "hive"."qa_cases" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_ci_run_cases_rw" ON "hive"."qa_ci_run_cases" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_ci_runs_rw" ON "hive"."qa_ci_runs" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_ci_sources_rw" ON "hive"."qa_ci_sources" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_project_settings_rw" ON "hive"."qa_project_settings" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_result_history_rw" ON "hive"."qa_result_history" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_round_assignees_rw" ON "hive"."qa_round_assignees" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_round_cases_rw" ON "hive"."qa_round_cases" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_rounds_rw" ON "hive"."qa_rounds" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_settings_select" ON "hive"."qa_settings" AS PERMISSIVE FOR SELECT TO "hive_app" USING (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_settings_insert" ON "hive"."qa_settings" AS PERMISSIVE FOR INSERT TO "hive_app" WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_settings_update" ON "hive"."qa_settings" AS PERMISSIVE FOR UPDATE TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "qa_settings_owner_select" ON "hive"."qa_settings" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);
--> statement-breakpoint
-- Khóa ngoại cũng kiểm org_id vì kiểm tham chiếu không chịu RLS.
ALTER TABLE hive.qa_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.qa_settings TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.qa_settings FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.qa_settings ADD CONSTRAINT qa_settings_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.qa_project_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.qa_project_settings TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.qa_project_settings FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.qa_project_settings ADD CONSTRAINT qa_project_settings_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.qa_areas FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.qa_areas TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.qa_areas FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.qa_areas ADD CONSTRAINT qa_areas_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.qa_cases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.qa_cases TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.qa_cases FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.qa_cases ADD CONSTRAINT qa_cases_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.qa_case_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.qa_case_versions TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.qa_case_versions FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.qa_case_versions ADD CONSTRAINT qa_case_versions_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.qa_case_status FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.qa_case_status TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.qa_case_status FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.qa_case_status ADD CONSTRAINT qa_case_status_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.qa_ci_sources FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.qa_ci_sources TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.qa_ci_sources FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.qa_ci_sources ADD CONSTRAINT qa_ci_sources_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.qa_ci_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.qa_ci_runs TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.qa_ci_runs FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.qa_ci_runs ADD CONSTRAINT qa_ci_runs_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.qa_ci_run_cases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.qa_ci_run_cases TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.qa_ci_run_cases FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.qa_ci_run_cases ADD CONSTRAINT qa_ci_run_cases_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.qa_rounds FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.qa_rounds TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.qa_rounds FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.qa_rounds ADD CONSTRAINT qa_rounds_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.qa_round_cases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.qa_round_cases TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.qa_round_cases FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.qa_round_cases ADD CONSTRAINT qa_round_cases_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.qa_round_assignees FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.qa_round_assignees TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.qa_round_assignees FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.qa_round_assignees ADD CONSTRAINT qa_round_assignees_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.qa_result_history FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.qa_result_history TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.qa_result_history FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.qa_result_history ADD CONSTRAINT qa_result_history_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
-- Dự án, tài liệu và thành viên nằm ở catalog/knowledge/tenancy; khóa ngoại viết tay để schema.ts không import chéo module.
ALTER TABLE hive.qa_project_settings ADD CONSTRAINT qa_project_settings_project_id_org_fk FOREIGN KEY (project_id, org_id) REFERENCES hive.projects(id, org_id) ON DELETE CASCADE;
ALTER TABLE hive.qa_areas ADD CONSTRAINT qa_areas_project_id_org_fk FOREIGN KEY (project_id, org_id) REFERENCES hive.projects(id, org_id) ON DELETE CASCADE;
ALTER TABLE hive.qa_cases ADD CONSTRAINT qa_cases_project_id_org_fk FOREIGN KEY (project_id, org_id) REFERENCES hive.projects(id, org_id) ON DELETE CASCADE;
ALTER TABLE hive.qa_case_status ADD CONSTRAINT qa_case_status_project_id_org_fk FOREIGN KEY (project_id, org_id) REFERENCES hive.projects(id, org_id) ON DELETE CASCADE;
ALTER TABLE hive.qa_ci_sources ADD CONSTRAINT qa_ci_sources_project_id_org_fk FOREIGN KEY (project_id, org_id) REFERENCES hive.projects(id, org_id) ON DELETE CASCADE;
ALTER TABLE hive.qa_rounds ADD CONSTRAINT qa_rounds_project_id_org_fk FOREIGN KEY (project_id, org_id) REFERENCES hive.projects(id, org_id) ON DELETE CASCADE;
-- Tài liệu bị xoá thì khu còn lại với `doc_key`; chỉ đặt null `doc_id`, giữ `org_id` (Postgres 15+).
ALTER TABLE hive.qa_areas ADD CONSTRAINT qa_areas_doc_id_org_fk FOREIGN KEY (doc_id, org_id) REFERENCES hive.docs(id, org_id) ON DELETE SET NULL (doc_id);
-- Người được giao phải là thành viên tổ chức; rời tổ chức thì bỏ phân công. Đội của dự án do hub kiểm lúc giao.
ALTER TABLE hive.qa_round_assignees ADD CONSTRAINT qa_round_assignees_member_fk FOREIGN KEY (org_id, user_id) REFERENCES hive.org_members(org_id, user_id) ON DELETE CASCADE;
-- Khóa ngoại ghép trong module nhưng chỉ đặt null một cột: drizzle chỉ sinh được SET NULL cả `org_id`.
ALTER TABLE hive.qa_rounds ADD CONSTRAINT qa_rounds_previous_round_fk FOREIGN KEY (previous_round_id, org_id) REFERENCES hive.qa_rounds(id, org_id) ON DELETE SET NULL (previous_round_id);
ALTER TABLE hive.qa_case_status ADD CONSTRAINT qa_case_status_ci_run_fk FOREIGN KEY (ci_run_id, org_id) REFERENCES hive.qa_ci_runs(id, org_id) ON DELETE SET NULL (ci_run_id);
ALTER TABLE hive.qa_case_status ADD CONSTRAINT qa_case_status_manual_round_case_fk FOREIGN KEY (manual_round_case_id, org_id) REFERENCES hive.qa_round_cases(id, org_id) ON DELETE SET NULL (manual_round_case_id);
