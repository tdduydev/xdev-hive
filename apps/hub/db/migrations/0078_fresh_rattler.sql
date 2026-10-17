CREATE TABLE "hive"."project_members" (
	"project_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."project_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."project_members" ADD CONSTRAINT "project_members_project_id_org_id_team_id_projects_id_org_id_team_id_fk" FOREIGN KEY ("project_id","org_id","team_id") REFERENCES "hive"."projects"("id","org_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_members_user" ON "hive"."project_members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE POLICY "project_members_rw" ON "hive"."project_members" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.project_members TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.project_members FROM hive_app;
--> statement-breakpoint
-- Chỉ người trong đội của dự án mới là thành viên dự án; gỡ khỏi đội thì mất luôn thành viên dự án.
ALTER TABLE hive.project_members ADD CONSTRAINT project_members_team_member_fk FOREIGN KEY (team_id, user_id) REFERENCES hive.team_members (team_id, user_id) ON DELETE CASCADE;
--> statement-breakpoint
-- Chủ bảng cũng chịu FORCE RLS; chỉ tắt FORCE trong transaction migration để điền mọi tổ chức. Người tạo dự án còn
-- trong đội thành thành viên đầu tiên, để bộ lọc "dự án của tôi" không rỗng với dữ liệu cũ.
ALTER TABLE hive.projects NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.team_members NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO hive.project_members (project_id, org_id, team_id, user_id, added_by)
SELECT p.id, p.org_id, p.team_id, p.created_by, p.created_by
  FROM hive.projects p
  JOIN hive.team_members m ON m.team_id = p.team_id AND m.user_id = p.created_by;
--> statement-breakpoint
ALTER TABLE hive.projects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.team_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.project_members FORCE ROW LEVEL SECURITY;
