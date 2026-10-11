CREATE TYPE "hive"."scm_auth_mode" AS ENUM('app', 'token');--> statement-breakpoint
ALTER TABLE "hive"."scm_connections" ADD COLUMN "auth_mode" "hive"."scm_auth_mode" DEFAULT 'app' NOT NULL;