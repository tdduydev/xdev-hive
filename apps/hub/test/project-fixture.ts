import { randomUUID } from "node:crypto";
import { defaultProjectSettings, type ProjectSettings } from "@xdev-hive/contracts";
import type pg from "pg";
import { type MasterKey, withTenant } from "../src/modules/platform/index.ts";
import { createConnection } from "../src/modules/scm/index.ts";

/**
 * Seed một dự án đã khởi tạo xong (state active, có repo) cho test task và run. Kết nối Git tạo qua createConnection
 * (cần khoá chủ để mã hoá token) bằng quản trị tổ chức; dự án chèn thẳng bằng superuser vì saga khởi tạo đã có test
 * riêng ở module catalog.
 */
export async function seedProject(
  admin: pg.Pool,
  app: pg.Pool,
  opts: {
    orgId: string;
    teamId: string;
    systemId: string;
    adminUserId: string;
    masterKey: MasterKey;
    key: string;
    settings?: ProjectSettings;
  },
): Promise<{ projectId: string; connectionId: string; owner: string; repo: string }> {
  const conn = await withTenant(app, { userId: opts.adminUserId, orgId: opts.orgId }, (tx) =>
    createConnection(tx, opts.masterKey, opts.adminUserId, {
      kind: "gitlab",
      name: `gl-${opts.key}`,
      baseUrl: "https://gitlab.com",
      defaultOwner: "xdev-team",
      token: "glpat-test-token",
    }),
  );
  const owner = "xdev-team";
  const repo = `repo-${opts.key}`;
  const { rows } = await admin.query(
    `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
       repo_owner, repo_name, default_branch, repo_http_url, repo_web_url, state, settings, idempotency_key, created_by)
     values ($1, $2, $3, $4, $4, $5, 'gitlab', 'existing', $6, $7, 'main', $8, $9, 'active', $10, $11, $12)
     returning id`,
    [
      opts.orgId,
      opts.teamId,
      opts.systemId,
      opts.key,
      conn.id,
      owner,
      repo,
      `https://gitlab.com/${owner}/${repo}.git`,
      `https://gitlab.com/${owner}/${repo}`,
      JSON.stringify(opts.settings ?? defaultProjectSettings()),
      randomUUID(),
      opts.adminUserId,
    ],
  );
  return { projectId: rows[0].id as string, connectionId: conn.id, owner, repo };
}
