ALTER TABLE "auth"."ssoProvider" ADD COLUMN "domainVerified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ssoProvider_domain_uidx" ON "auth"."ssoProvider" USING btree (lower("domain"));--> statement-breakpoint
CREATE POLICY "org_members_owner_select" ON "hive"."org_members" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);