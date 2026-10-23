CREATE TABLE "hive"."sdlc_qa_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"code" text NOT NULL,
	"definition" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"waived_by" text,
	"waiver_reason" text,
	"waived_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sdlc_qa_cases_item_code" UNIQUE("item_id","code"),
	CONSTRAINT "sdlc_qa_cases_waiver" CHECK ((waived_by is null and waiver_reason is null and waived_at is null)
    or (waived_by is not null and waiver_reason is not null and waived_at is not null))
);
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_qa_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."sdlc_qa_cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."sdlc_qa_cases" ADD CONSTRAINT "sdlc_qa_cases_item_fk" FOREIGN KEY ("item_id","org_id") REFERENCES "hive"."sdlc_items"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "sdlc_qa_cases_rw" ON "hive"."sdlc_qa_cases" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());
