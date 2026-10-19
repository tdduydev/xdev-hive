import { randomBytes, randomUUID } from "node:crypto";
import { projectCreateInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { createJobs, createPool, parseMasterKey, withTenant } from "../platform/index.ts";
import { createConnection, createMemoryProvider, type MemoryProvider, type ProviderFactory } from "../scm/index.ts";
import { type CatalogDeps, createProject } from "./projects.ts";
import { provisionQueue, runProvision } from "./saga.ts";
import { refreshProjectWebhooks } from "./webhook-refresh.ts";

const { adminUrl, appUrl, jobsUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const publicUrl = "https://hive.example.com";
const jobs = createJobs({ connectionString: jobsUrl, queues: [provisionQueue], maintenance: false });

const providers = new Map<string, MemoryProvider>();
const providerFactory: ProviderFactory = (conn) => {
  let p = providers.get(conn.id);
  if (!p) {
    p = createMemoryProvider(conn.kind, [conn.defaultOwner ?? "xdev-team"]);
    providers.set(conn.id, p);
  }
  return p;
};
const deps: CatalogDeps = { masterKey, providerFactory, publicUrl, jobs };
const sagaDeps = { pool: app, masterKey, providerFactory, publicUrl };

let org: OrgFixture & { user: (n: string) => string };
const conns: Record<"gitlab" | "github", string> = { gitlab: "", github: "" };
const actor = () => ({ userId: org.user("tadmin"), orgId: org.orgId });

/** Tạo dự án repo mới qua saga thật tới khi active, trả id và repo trên provider giả. */
async function activeProject(kind: "gitlab" | "github", key: string) {
  const r = await createProject(
    app,
    deps,
    actor(),
    projectCreateInput.parse({
      systemId: org.systemId,
      key,
      name: key,
      repo: { mode: "new", connectionId: conns[kind], owner: "xdev-team", name: key },
      idempotencyKey: randomUUID(),
    }),
  );
  const id = r.projectId as string;
  expect(await runProvision(sagaDeps, { orgId: org.orgId, projectId: id })).toBe("active");
  const repo = providers.get(conns[kind])?.repos.get(`xdev-team/${key}`);
  if (!repo) throw new Error(`thiếu repo ${key}`);
  // Hook như dự án tạo trước T005: chưa có pipeline, job.
  for (const hook of repo.hooks.values()) hook.events = ["push", "pull_request", "issues", "issue_comment"];
  return { id, repo };
}

beforeAll(async () => {
  org = await seedOrg(admin, "whr");
  await jobs.start();
  await withTenant(app, { userId: org.user("owner"), orgId: org.orgId }, async (tx) => {
    conns.gitlab = (
      await createConnection(tx, masterKey, org.user("owner"), {
        kind: "gitlab",
        name: "GitLab nội bộ",
        baseUrl: "https://gitlab.example.com",
        defaultOwner: "xdev-team",
        token: "glpat-khong-dung-that",
      })
    ).id;
    conns.github = (
      await createConnection(tx, masterKey, org.user("owner"), {
        kind: "github",
        name: "GitHub App",
        defaultOwner: "xdev-team",
        appId: "12345",
        privateKey: "-----BEGIN RSA PRIVATE KEY-----\nkhong-dung-that\n-----END RSA PRIVATE KEY-----\n",
        installationId: 678,
      })
    ).id;
  });
});

afterAll(async () => {
  await jobs.stop();
  await Promise.all([admin.end(), app.end()]);
});

describe("refreshProjectWebhooks", () => {
  it("dự án GitLab đang hoạt động: cùng webhook, thêm pipeline, job; GitHub và dự án lưu trữ giữ nguyên", async () => {
    const gl = await activeProject("gitlab", "whr-gl");
    const archived = await activeProject("gitlab", "whr-luu");
    const gh = await activeProject("github", "whr-gh");
    await admin.query("update hive.projects set state = 'archived' where id = $1", [archived.id]);
    const before = [...gl.repo.hooks.entries()];

    const result = await refreshProjectWebhooks({ pool: app, masterKey, providerFactory, publicUrl }, [org.orgId]);

    expect(result).toEqual({ updated: 1, failed: [] });
    const after = [...gl.repo.hooks.entries()];
    expect(after.map(([id]) => id)).toEqual(before.map(([id]) => id));
    expect(after[0]?.[1]).toMatchObject({
      url: `${publicUrl}/hooks/git/${gl.id}`,
      events: ["push", "pull_request", "issues", "issue_comment", "pipeline", "job"],
    });
    expect([...archived.repo.hooks.values()][0]?.events).not.toContain("pipeline");
    expect([...gh.repo.hooks.values()][0]?.events).not.toContain("pipeline");
  });

  it("tổ chức không có dự án GitLab thì không làm gì", async () => {
    expect(await refreshProjectWebhooks({ pool: app, masterKey, providerFactory, publicUrl }, [randomUUID()])).toEqual({
      updated: 0,
      failed: [],
    });
  });
});
