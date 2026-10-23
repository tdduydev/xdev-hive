import { randomBytes, randomUUID } from "node:crypto";
import { deployVersion } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { createPool, encryptSecret, parseMasterKey, withTenant } from "../platform/index.ts";
import { createMemoryProvider } from "../scm/index.ts";
import { setDeliveryOutbound } from "./clients/outbound.ts";
import { compareDeploy, prepareDeployCompare } from "./compare.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
let org: Awaited<ReturnType<typeof seedOrg>>;
let scmId: string;
const version = (commit: string) =>
  deployVersion.parse({ commit, tag: null, jenkinsBuild: null, image: null, images: [], revision: null });

beforeAll(async () => {
  org = await seedOrg(admin, `compare-${randomUUID().slice(0, 8)}`);
  scmId = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'GitLab', $3, $4)",
    [
      scmId,
      org.orgId,
      encryptSecret(masterKey, JSON.stringify({ token: "test-token" }), `scm_connections:${scmId}`),
      org.user("owner"),
    ],
  );
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

async function target(projectId?: string) {
  const project = projectId ?? randomUUID();
  if (!projectId)
    await admin.query(
      `insert into hive.projects
    (id, org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode, repo_owner, repo_name, settings, idempotency_key, created_by)
    values ($1, $2, $3, $4, $5, 'Ứng dụng', $6, 'gitlab', 'existing', 'acme', $5, '{}', $7, $8)`,
      [
        project,
        org.orgId,
        org.teamId,
        org.systemId,
        `p-${project.slice(0, 8)}`,
        scmId,
        randomUUID(),
        org.user("owner"),
      ],
    );
  const env = randomUUID();
  await admin.query(
    `insert into hive.deploy_environments (id, org_id, team_id, system_id, name, policy)
    values ($1, $2, $3, $4, $5, '{"deployRoles":[],"approveRoles":[],"approvals":0,"approvalTtlHours":24}')`,
    [env, org.orgId, org.teamId, org.systemId, env],
  );
  const id = randomUUID();
  await admin.query(
    `insert into hive.deploy_targets (id, org_id, project_id, environment_id, method, config)
    values ($1, $2, $3, $4, 'jenkins-job', '{"method":"jenkins-job"}')`,
    [id, org.orgId, project, env],
  );
  return { id, projectId: project };
}

async function deploy(targetId: string, state: string, commit: string, created: string, finished: string | null) {
  const id = randomUUID();
  await admin.query(
    `insert into hive.deploys (id, org_id, target_id, method, origin, state, version, created_at, finished_at)
    values ($1, $2, $3, 'jenkins-job', 'external', $4, $5, $6, $7)`,
    [id, org.orgId, targetId, state, version(commit), created, finished],
  );
  return id;
}

const prepare = (id: string, name = "tviewer", orgId?: string) =>
  withTenant(app, { orgId: orgId ?? org.orgId, userId: org.user(name) }, (tx) =>
    prepareDeployCompare(tx, {}, org.user(name), id),
  );

describe("mốc so sánh của lần triển khai", () => {
  it("chọn bản thành công gần nhất cùng đích theo giờ hoàn thành, không lấy lỗi, đích khác hay bản tương lai", async () => {
    const t = await target();
    const sameProject = await target(t.projectId);
    const otherProject = await target();
    await deploy(t.id, "succeeded", "cũ", "2026-10-20T01:00:00Z", "2026-10-20T03:00:00Z");
    await deploy(t.id, "succeeded", "đúng", "2026-10-20T00:00:00Z", "2026-10-20T04:00:00Z");
    await deploy(t.id, "failed", "lỗi", "2026-10-20T05:00:00Z", "2026-10-20T06:00:00Z");
    await deploy(sameProject.id, "succeeded", "khác-môi-trường", "2026-10-20T07:00:00Z", "2026-10-20T08:00:00Z");
    await deploy(otherProject.id, "succeeded", "khác-dự-án", "2026-10-20T07:00:00Z", "2026-10-20T08:00:00Z");
    const id = await deploy(t.id, "succeeded", "mới", "2026-10-20T09:00:00Z", "2026-10-20T10:00:00Z");
    await deploy(t.id, "succeeded", "tương-lai", "2026-10-21T01:00:00Z", "2026-10-21T02:00:00Z");
    expect((await prepare(id)).comparison).toEqual({
      from: version("đúng"),
      to: version("mới"),
      commits: [],
      incomplete: true,
    });
  });

  it("chưa có bản trước trả from null và giữ nguyên bản sẽ lên", async () => {
    const t = await target();
    const id = await deploy(t.id, "pending_approval", "mới", "2026-10-20T01:00:00Z", null);
    expect((await prepare(id)).comparison).toEqual({ from: null, to: version("mới"), commits: [], incomplete: true });
  });

  it("không lộ lần của tổ chức khác và cho người có ci.view xem", async () => {
    const t = await target();
    const id = await deploy(t.id, "succeeded", "mới", "2026-10-20T01:00:00Z", "2026-10-20T02:00:00Z");
    expect((await prepare(id)).comparison.to).toEqual(version("mới"));
    const other = await seedOrg(admin, `compare-other-${randomUUID().slice(0, 8)}`);
    await expect(prepare(id, "tviewer", other.orgId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(prepare(randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("dùng đúng kết nối và repo của dự án; tắt outbound thì không tạo provider", async () => {
    const t = await target();
    await deploy(t.id, "succeeded", "old", "2026-10-20T01:00:00Z", "2026-10-20T02:00:00Z");
    const id = await deploy(t.id, "pending_approval", "new", "2026-10-20T03:00:00Z", null);
    const provider = createMemoryProvider();
    provider.compare = vi.fn().mockResolvedValue({ files: [], commits: [], incomplete: false });
    const providerFactory = vi.fn(() => provider);
    const deps = { pool: app, masterKey, providerFactory };
    const actor = { orgId: org.orgId, userId: org.user("tviewer") };
    const result = await compareDeploy(deps, actor, id);
    expect(result).toEqual({ from: version("old"), to: version("new"), commits: [], incomplete: false });
    expect(providerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ id: scmId, secret: { token: "test-token" } }),
    );
    expect(provider.compare).toHaveBeenCalledWith(
      { owner: "acme", name: `p-${t.projectId.slice(0, 8)}` },
      "old",
      "new",
    );
    providerFactory.mockClear();
    try {
      setDeliveryOutbound(false);
      expect((await compareDeploy(deps, actor, id)).incomplete).toBe(true);
      expect(providerFactory).not.toHaveBeenCalled();
    } finally {
      setDeliveryOutbound(true);
    }
  });
});
