CREATE TABLE "hive"."db_epoch" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"epoch" uuid DEFAULT gen_random_uuid() NOT NULL,
	"restored_to" timestamp with time zone,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "db_epoch_single_row" CHECK (id)
);
--> statement-breakpoint
ALTER TABLE "hive"."db_epoch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "db_epoch_read" ON "hive"."db_epoch" AS PERMISSIVE FOR SELECT TO "hive_app" USING (true);--> statement-breakpoint
-- Dòng đầu tiên trước khi ép RLS: chủ bảng (người chạy migration) không có policy ghi.
INSERT INTO hive.db_epoch DEFAULT VALUES;
--> statement-breakpoint
ALTER TABLE hive.db_epoch FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- DEFAULT PRIVILEGES của 0002 cấp quyền ghi cho hive_app; mốc chỉ do script khôi phục chạy bằng postgres đổi.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON hive.db_epoch FROM hive_app;
