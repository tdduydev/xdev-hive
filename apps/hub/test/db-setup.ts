// Dựng Postgres thật (cùng image với production) cho test có database, chạy bootstrap và migration một lần.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";
import { bootstrapRoles, runMigrations } from "../src/modules/platform/index.ts";

// Cùng image với production. Docker Hub giới hạn lượt tải theo IP, nên cho đổi sang mirror
// (vd. public.ecr.aws/docker/library/postgres:18-trixie) qua HIVE_TEST_POSTGRES_IMAGE khi cần.
export const POSTGRES_IMAGE = process.env.HIVE_TEST_POSTGRES_IMAGE ?? "pgvector/pgvector:0.8.7-pg18-trixie";

declare module "vitest" {
  export interface ProvidedContext {
    db: { adminUrl: string; ownerUrl: string; appUrl: string };
  }
}

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject) {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).withDatabase("hive").start();
  const adminUrl = container.getConnectionUri();
  const pw = { owner: "owner-test", app: "app-test", auth: "auth-test" };
  await bootstrapRoles(adminUrl, pw);
  const url = (user: string, password: string) => {
    const u = new URL(adminUrl);
    u.username = user;
    u.password = password;
    return u.toString();
  };
  const ownerUrl = url("hive_owner", pw.owner);
  await runMigrations(ownerUrl);
  project.provide("db", { adminUrl, ownerUrl, appUrl: url("hive_app", pw.app) });
}

export async function teardown() {
  await container?.stop();
}
