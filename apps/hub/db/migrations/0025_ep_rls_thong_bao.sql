-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE hive.notification_channels FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- TRUNCATE không qua RLS; default privileges chưa cấp, thu lại cho chắc.
REVOKE TRUNCATE ON TABLE hive.notification_channels, hive.notifications FROM hive_app;
--> statement-breakpoint
-- Khoá ngoại sang bảng của module khác viết tay, vì schema.ts của module không được import bảng của tenancy.
ALTER TABLE hive.notification_channels ADD CONSTRAINT notification_channels_org_fk
  FOREIGN KEY (org_id) REFERENCES hive.orgs (id) ON DELETE CASCADE;
--> statement-breakpoint
-- Khoá kép theo tổ chức: khoá ngoại bỏ qua RLS, thiếu org_id thì dòng thông báo trỏ được tới kênh của tổ chức khác.
-- Xoá kênh thì lịch sử gửi của nó đi theo.
ALTER TABLE hive.notifications ADD CONSTRAINT notifications_channel_fk
  FOREIGN KEY (channel_id, org_id) REFERENCES hive.notification_channels (id, org_id) ON DELETE CASCADE;
