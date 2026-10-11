CREATE TYPE "hive"."sso_join" AS ENUM('pending', 'member');--> statement-breakpoint
ALTER TABLE "hive"."orgs" ADD COLUMN "sso_join" "hive"."sso_join" DEFAULT 'pending' NOT NULL;