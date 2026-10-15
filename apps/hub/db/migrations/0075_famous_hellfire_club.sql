-- Webhook của nhà tài liệu (/hooks/docs/{id}) đến không có phiên nên chưa biết tổ chức. Module docsync đặt id nhà vào
-- app.webhook_doc_home_id trong transaction; policy doc_homes_webhook cho thấy đúng dòng đó, giống
-- ctx_webhook_skill_repo của kho skill. Không dùng SECURITY DEFINER vì bảng bị FORCE RLS.
CREATE FUNCTION hive.ctx_webhook_doc_home() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.webhook_doc_home_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE POLICY "doc_homes_webhook" ON "hive"."doc_homes" AS PERMISSIVE FOR SELECT TO "hive_app" USING (id = hive.ctx_webhook_doc_home());
