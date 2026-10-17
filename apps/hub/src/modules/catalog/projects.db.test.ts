import { randomBytes, randomUUID } from "node:crypto";
import { type ProjectCreateInput, projectCreateInput } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import pg from "pg";
import { MockAgent, fetch as undiciFetch } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { createChannel } from "../notify/index.ts";
import { createJobs, createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import {
  createConnection,
  createMemoryProvider,
  createProviderFactory,
  GitProviderError,
  type MemoryProvider,
  type ProviderFactory,
  removeConnection,
} from "../scm/index.ts";
import {
  type CatalogDeps,
  createProject,
  dryRunCreate,
  getProvision,
  listProjects,
  PROVISION_QUEUE,
  retryStep,
} from "./projects.ts";
import { provisionQueue, RetryLater, registerProvisionWorker, runProvision } from "./saga.ts";
import { projectProvisionSteps, projects } from "./schema.ts";

const { adminUrl, appUrl, jobsUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const publicUrl = "https://hive.example.com";
const jobs = createJobs({ connectionString: jobsUrl, queues: [provisionQueue], maintenance: false });

// Mỗi kết nối một provider giả, giữ trạng thái qua các lần saga dựng lại provider.
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
let other: OrgFixture & { user: (n: string) => string };
let connectionId = "";
const provider = () =>
  providerFactory({ id: connectionId, kind: "github", defaultOwner: "xdev-team" } as never) as MemoryProvider;
const actor = (who: string) => ({ userId: org.user(who), orgId: org.orgId });
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) => withTenant(app, actor(who), fn);

let seq = 0;
function input(over: Partial<ProjectCreateInput> = {}) {
  seq += 1;
  return projectCreateInput.parse({
    systemId: org.systemId,
    key: `du-an-${seq}`,
    name: `Dự án ${seq}`,
    repo: { mode: "new", connectionId, owner: "xdev-team", name: `repo-${seq}` },
    idempotencyKey: randomUUID(),
    ...over,
  });
}

async function steps(projectId: string) {
  const { rows } = await admin.query(
    "select kind, state, error, result, attempts from hive.project_provision_steps where project_id = $1 order by position",
    [projectId],
  );
  return rows as Array<{
    kind: string;
    state: string;
    error: { code: string; fix: string } | null;
    result: unknown;
    attempts: number;
  }>;
}

async function projectState(id: string): Promise<string> {
  return (await admin.query("select state from hive.projects where id = $1", [id])).rows[0]?.state;
}

async function jobCount(projectId: string): Promise<number> {
  const { rows } = await admin.query(
    "select count(*)::int as n from pgboss.job where name = $1 and singleton_key = $2 and state in ('created', 'retry')",
    [PROVISION_QUEUE, projectId],
  );
  return rows[0].n;
}

beforeAll(async () => {
  org = await seedOrg(admin, "cat");
  other = await seedOrg(admin, "cat2");
  await jobs.start();
  const conn = await as("owner", (tx) =>
    createConnection(tx, masterKey, org.user("owner"), {
      kind: "github",
      name: "GitHub App xDev Hive",
      defaultOwner: "xdev-team",
      appId: "12345",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nkhong-dung-that\n-----END RSA PRIVATE KEY-----\n",
      installationId: 678,
    }),
  );
  connectionId = conn.id;
});

afterAll(async () => {
  await jobs.stop();
  await Promise.all([admin.end(), app.end()]);
});

describe("projects.create: phân quyền", () => {
  it.each([
    ["tmember", "TEAM_ROLE_REQUIRED"],
    ["tviewer", "TEAM_ROLE_REQUIRED"],
    ["oadmin", "NOT_TEAM_MEMBER"],
    ["loner", "NOT_TEAM_MEMBER"],
  ])("%s không tạo được dự án trong hệ thống của đội Thanh toán", async (who, code) => {
    expect(await errorCode(() => dryRunCreate(app, deps, actor(who), input({ dryRun: true })))).toBe(code);
    expect(await errorCode(() => createProject(app, deps, actor(who), input()))).toBe(code);
  });

  it.each(["tadmin", "admin", "owner"])("%s chạy thử được", async (who) => {
    const r = await dryRunCreate(app, deps, actor(who), input({ dryRun: true }));
    expect(r.state).toBe("planned");
  });

  it("hệ thống của tổ chức khác thì NOT_FOUND", async () => {
    expect(await errorCode(() => dryRunCreate(app, deps, actor("owner"), input({ systemId: other.systemId })))).toBe(
      "SYSTEM_NOT_FOUND",
    );
  });
});

describe("projects.create dryRun", () => {
  it("trả kế hoạch các bước, không ghi gì", async () => {
    // Đếm trong tổ chức của file này: file test khác chạy song song trên cùng database cũng tạo dự án.
    const count = async () =>
      (await admin.query("select count(*)::int as n from hive.projects where org_id = $1", [org.orgId])).rows[0].n;
    const before = await count();
    const r = await dryRunCreate(app, deps, actor("tadmin"), input({ dryRun: true }));
    expect(r.projectId).toBeNull();
    expect(r.steps.map((s) => s.kind)).toEqual([
      "check-access",
      "create-repo",
      "commit-template",
      "protect-branch",
      "add-webhook",
    ]);
    expect(r.steps[3]?.title).toContain("cần 1 người duyệt");
    expect(r.warnings).toEqual([]);
    expect(await count()).toBe(before);
  });

  it("bỏ bảo vệ nhánh và webhook thì không có hai bước đó", async () => {
    const r = await dryRunCreate(
      app,
      deps,
      actor("tadmin"),
      input({ protection: { protectDefault: false, requiredApprovals: 0 }, webhook: false }),
    );
    expect(r.steps.map((s) => s.kind)).toEqual(["check-access", "create-repo", "commit-template"]);
  });

  it("cảnh báo khi kết nối không có quyền trên owner và khi repo trùng tên đã có", async () => {
    provider().seedRepo({ owner: "xdev-team", name: "da-co" });
    const noAccess = await dryRunCreate(
      app,
      deps,
      actor("tadmin"),
      input({ repo: { mode: "new", connectionId, owner: "to-chuc-khac", name: "x" } }),
    );
    expect(noAccess.warnings.map((w) => w.code)).toContain("ACCESS_MISSING");
    const exists = await dryRunCreate(
      app,
      deps,
      actor("tadmin"),
      input({ repo: { mode: "new", connectionId, owner: "xdev-team", name: "da-co" } }),
    );
    expect(exists.warnings.map((w) => w.code)).toEqual(["REPO_EXISTS"]);
  });

  it("repo có sẵn: đọc repo, cảnh báo khi không thấy", async () => {
    const r = await dryRunCreate(
      app,
      deps,
      actor("tadmin"),
      input({ repo: { mode: "existing", connectionId, url: "https://github.com/xdev-team/khong-co" } }),
    );
    expect(r.steps.map((s) => s.kind)).toEqual(["link-repo", "commit-template", "protect-branch", "add-webhook"]);
    expect(r.warnings.map((w) => w.code)).toEqual(["REPO_NOT_FOUND"]);
  });

  it("lỗi của nhà cung cấp thành cảnh báo, không làm hỏng kế hoạch", async () => {
    provider().fail("checkAccess", new GitProviderError("unavailable", "GitHub: dịch vụ tạm thời không phản hồi"));
    try {
      const r = await dryRunCreate(app, deps, actor("tadmin"), input());
      expect(r.warnings.map((w) => w.code)).toEqual(["SCM_ERROR"]);
    } finally {
      provider().fail("checkAccess", null);
    }
  });
});

describe("projects.create chạy thật", () => {
  it("một transaction: dự án provisioning, các bước, job pg-boss, audit", async () => {
    const req = input();
    const r = await createProject(app, deps, actor("tadmin"), req);
    expect(r).toMatchObject({ dryRun: false, state: "provisioning" });
    const id = r.projectId as string;
    expect(await projectState(id)).toBe("provisioning");
    expect((await steps(id)).map((s) => s.state)).toEqual(["pending", "pending", "pending", "pending", "pending"]);
    expect(await jobCount(id)).toBe(1);
    const audit = await admin.query("select action, actor_user_id from hive.audit_log where target_id = $1", [id]);
    expect(audit.rows).toEqual([{ action: "project.create", actor_user_id: org.user("tadmin") }]);
    const row = (
      await admin.query("select settings, webhook_secret_enc, team_id from hive.projects where id = $1", [id])
    ).rows[0];
    expect(row.team_id).toBe(org.teamId);
    expect(row.settings.merge).toEqual({ mode: "review", requiredApprovals: 1 });
    expect(row.webhook_secret_enc).toMatch(/^v1\./);
    const members = await admin.query("select user_id, added_by from hive.project_members where project_id = $1", [id]);
    expect(members.rows).toEqual([{ user_id: org.user("tadmin"), added_by: org.user("tadmin") }]);
  });

  it("quản trị tổ chức không ở đội tạo dự án được, không thành thành viên dự án", async () => {
    const r = await createProject(app, deps, actor("admin"), input());
    const id = r.projectId as string;
    const members = await admin.query("select user_id from hive.project_members where project_id = $1", [id]);
    expect(members.rows).toEqual([]);
  });

  it("idempotencyKey gửi hai lần chỉ tạo một dự án", async () => {
    const req = input();
    const a = await createProject(app, deps, actor("tadmin"), req);
    const b = await createProject(app, deps, actor("tadmin"), req);
    expect(b.projectId).toBe(a.projectId);
    const n = await admin.query("select count(*)::int as n from hive.projects where idempotency_key = $1", [
      req.idempotencyKey,
    ]);
    expect(n.rows[0].n).toBe(1);
    expect(await jobCount(a.projectId as string)).toBe(1);
  });

  it("idempotencyKey gửi hai lần cùng lúc cũng chỉ tạo một dự án", async () => {
    const req = input();
    const [a, b] = await Promise.all([
      createProject(app, deps, actor("tadmin"), req),
      createProject(app, deps, actor("admin"), req),
    ]);
    expect(a.projectId).toBe(b.projectId);
  });

  it("gửi lại khoá chống trùng của người khác không qua được kiểm quyền", async () => {
    const req = input();
    await createProject(app, deps, actor("tadmin"), req);
    expect(await errorCode(() => createProject(app, deps, actor("tmember"), req))).toBe("TEAM_ROLE_REQUIRED");
  });

  it("project key trùng trong tổ chức thì CONFLICT", async () => {
    const first = input();
    await createProject(app, deps, actor("tadmin"), first);
    expect(await errorCode(() => createProject(app, deps, actor("tadmin"), input({ key: first.key })))).toBe(
      "KEY_TAKEN",
    );
  });

  it("một repo chỉ thuộc một dự án", async () => {
    await createProject(
      app,
      deps,
      actor("tadmin"),
      input({ repo: { mode: "new", connectionId, owner: "xdev-team", name: "Chung" } }),
    );
    expect(
      await errorCode(() =>
        createProject(
          app,
          deps,
          actor("tadmin"),
          input({ repo: { mode: "new", connectionId, owner: "xdev-team", name: "chung" } }),
        ),
      ),
    ).toBe("REPO_TAKEN");
  });
});

describe("saga khởi tạo", () => {
  it("chạy hết các bước: tạo repo, commit file mẫu, bảo vệ nhánh, webhook; dự án active", async () => {
    const r = await createProject(app, deps, actor("tadmin"), input({ name: "Xuất file", key: "xuat-file" }));
    const id = r.projectId as string;
    expect(await runProvision(sagaDeps, { orgId: org.orgId, projectId: id })).toBe("active");
    expect(await projectState(id)).toBe("active");
    expect((await steps(id)).every((s) => s.state === "done" && s.attempts === 1)).toBe(true);

    const name = (await admin.query("select repo_name from hive.projects where id = $1", [id])).rows[0].repo_name;
    const repo = provider().repos.get(`xdev-team/${name}`);
    expect(repo?.info.description).toContain(`[xdev-hive:${id}]`);
    const files = repo?.branches.get("main");
    expect(files?.get("AGENTS.md")).toContain("Hive project key: `xuat-file`");
    expect(files?.get("CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(JSON.parse(files?.get(".mcp.json") ?? "{}").mcpServers["xdev-hive"].url).toBe(`${publicUrl}/mcp`);
    expect(repo?.protection.get("main")).toEqual({
      requirePullRequest: true,
      requiredApprovals: 1,
      allowForcePush: false,
    });
    const [hook] = [...(repo?.hooks.values() ?? [])];
    expect(hook?.url).toBe(`${publicUrl}/hooks/git/${id}`);
    expect(hook?.events).toEqual(["push", "pull_request", "issues", "issue_comment"]);
    expect(hook?.secret).toMatch(/^[0-9a-f]{64}$/);

    const view = await as("tviewer", (tx) => getProvision(tx, deps, org.user("tviewer"), id));
    expect(view.project.repo.webUrl).toBe(`https://github.com/xdev-team/${name}`);
    expect(view.steps[1]?.result).toMatchObject({ webUrl: `https://github.com/xdev-team/${name}` });

    // Job cũ chạy lại sau khi xong không làm gì thêm.
    const callsBefore = provider().calls.length;
    expect(await runProvision(sagaDeps, { orgId: org.orgId, projectId: id })).toBe("skipped");
    expect(provider().calls.length).toBe(callsBefore);
  });

  it("lỗi giữa chừng thì dừng ở bước đó với cách sửa, báo nhóm quản trị; retryStep chạy tiếp từ bước lỗi", async () => {
    await withTenant(app, { userId: org.user("admin"), orgId: org.orgId }, (tx) =>
      createChannel(
        tx,
        masterKey,
        org.user("admin"),
        {
          name: `saga-${org.orgId.slice(0, 6)}`,
          events: ["project.provision_failed"],
          config: { kind: "email", host: "smtp.example.com", from: "hive@example.com", to: ["qt@example.com"] },
        },
        { lookup: async () => [{ address: "8.8.8.8", family: 4 }] },
      ),
    );
    const r = await createProject(app, deps, actor("tadmin"), input());
    const id = r.projectId as string;
    provider().fail("protectBranch", new GitProviderError("forbidden", "GitHub: không đủ quyền", { status: 403 }));
    try {
      expect(await runProvision(sagaDeps, { orgId: org.orgId, projectId: id })).toBe("failed");
    } finally {
      provider().fail("protectBranch", null);
    }
    expect(await projectState(id)).toBe("failed");
    const failed = await steps(id);
    expect(failed.map((s) => s.state)).toEqual(["done", "done", "done", "failed", "pending"]);
    expect(failed[3]?.error).toMatchObject({ code: "SCM_FORBIDDEN" });
    expect(failed[3]?.error?.fix).toContain("Administration (ghi)");
    const { rows: notes } = await admin.query(
      "select event, title, body, link from hive.notifications where org_id = $1 and event = 'project.provision_failed'",
      [org.orgId],
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain("dừng ở bước protect-branch");
    expect(notes[0].body).toContain("không đủ quyền");
    expect(notes[0].link).toMatch(/^https:\/\/hive\.example\.com\/projects\//);
    const view = await as("tadmin", (tx) => getProvision(tx, deps, org.user("tadmin"), id));
    const protect = view.steps.find((s) => s.kind === "protect-branch");
    const done = view.steps.find((s) => s.kind === "create-repo");
    const { rows: inbox } = await admin.query(
      "select user_id, event, link from hive.inbox_items where org_id = $1 and event_key like $2",
      [org.orgId, `${protect?.id}:%`],
    );
    expect(inbox).toEqual([{ user_id: org.user("tadmin"), event: "project.provision_failed", link: notes[0].link }]);
    expect(protect?.state).toBe("failed");

    expect(
      await errorCode(() => as("tmember", (tx) => retryStep(tx, deps, actor("tmember"), id, protect?.id as string))),
    ).toBe("TEAM_ROLE_REQUIRED");
    expect(
      await errorCode(() => as("tadmin", (tx) => retryStep(tx, deps, actor("tadmin"), id, done?.id as string))),
    ).toBe("STEP_NOT_FAILED");

    const createdBefore = provider().calls.filter((c) => c.method === "createRepo").length;
    const retried = await as("tadmin", (tx) => retryStep(tx, deps, actor("tadmin"), id, protect?.id as string));
    expect(retried.project.state).toBe("provisioning");
    expect(retried.steps.find((s) => s.kind === "protect-branch")).toMatchObject({ state: "pending", error: null });
    expect(await jobCount(id)).toBeGreaterThanOrEqual(1);

    expect(await runProvision(sagaDeps, { orgId: org.orgId, projectId: id })).toBe("active");
    const after = await steps(id);
    expect(after.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(after[3]?.attempts).toBe(2);
    // Bước đã xong không chạy lại: repo không bị tạo lần nữa.
    expect(provider().calls.filter((c) => c.method === "createRepo").length).toBe(createdBefore);
    const audit = await admin.query(
      "select action from hive.audit_log where target_id = $1 and action like 'project.provision%' order by created_at",
      [id],
    );
    expect(audit.rows.map((a) => a.action)).toContain("project.provision.retry");
  });

  it("lỗi tạm thời còn lượt thử: bước về pending, báo pg-boss thử lại", async () => {
    const r = await createProject(app, deps, actor("tadmin"), input());
    const id = r.projectId as string;
    provider().fail("createRepo", new GitProviderError("rate_limited", "GitHub: vượt giới hạn"));
    try {
      await expect(
        runProvision(sagaDeps, { orgId: org.orgId, projectId: id }, { retryCount: 0, retryLimit: 3 }),
      ).rejects.toBeInstanceOf(RetryLater);
      expect((await steps(id))[1]?.state).toBe("pending");
      expect(await projectState(id)).toBe("provisioning");
      // Hết lượt thử thì dừng ở bước lỗi như lỗi thường.
      expect(await runProvision(sagaDeps, { orgId: org.orgId, projectId: id }, { retryCount: 3, retryLimit: 3 })).toBe(
        "failed",
      );
      expect((await steps(id))[1]?.error?.code).toBe("SCM_UNAVAILABLE");
    } finally {
      provider().fail("createRepo", null);
    }
  });

  it("kết nối không có quyền trên owner: dừng ở bước kiểm quyền", async () => {
    const r = await createProject(
      app,
      deps,
      actor("tadmin"),
      input({ repo: { mode: "new", connectionId, owner: "chua-cai-app", name: "x" } }),
    );
    const id = r.projectId as string;
    expect(await runProvision(sagaDeps, { orgId: org.orgId, projectId: id })).toBe("failed");
    const [check] = await steps(id);
    expect(check).toMatchObject({ kind: "check-access", state: "failed" });
    expect(check?.error?.code).toBe("ACCESS_DENIED");
    expect(check?.error?.fix).toContain("chua-cai-app");
  });

  it("repo có sẵn: đọc nhánh chính từ provider, file mẫu vào bằng PR, không commit thẳng", async () => {
    const legacy = provider().seedRepo({ owner: "xdev-team", name: "billing-export" }, { defaultBranch: "develop" });
    const r = await createProject(
      app,
      deps,
      actor("tadmin"),
      input({ repo: { mode: "existing", connectionId, url: "git@github.com:xdev-team/billing-export.git" } }),
    );
    const id = r.projectId as string;
    expect(await runProvision(sagaDeps, { orgId: org.orgId, projectId: id })).toBe("active");
    expect(legacy.commits.map((c) => c.branch)).toEqual(["hive/khoi-tao"]);
    expect(legacy.branches.get("develop")?.has("AGENTS.md")).toBe(false);
    expect(legacy.pulls).toMatchObject([{ head: "hive/khoi-tao", base: "develop" }]);
    expect(legacy.protection.has("develop")).toBe(true);
    const view = await as("tadmin", (tx) => getProvision(tx, deps, org.user("tadmin"), id));
    expect(view.project.repo.defaultBranch).toBe("develop");
    expect(view.steps.find((s) => s.kind === "commit-template")?.result).toMatchObject({ prNumber: 1 });
  });
});

describe("projects.list và quyền xem", () => {
  it("thành viên đội thấy dự án của đội; người ngoài đội không thấy", async () => {
    await createProject(app, deps, actor("tadmin"), input());
    const seen = await as("tviewer", (tx) => listProjects(tx, org.user("tviewer")));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.teamId === org.teamId)).toBe(true);
    expect(await as("loner", (tx) => listProjects(tx, org.user("loner")))).toEqual([]);
    expect(await as("oadmin", (tx) => listProjects(tx, org.user("oadmin"), org.systemId))).toEqual([]);
  });

  it("người ngoài đội xem chi tiết thì NOT_FOUND", async () => {
    const r = await createProject(app, deps, actor("tadmin"), input());
    expect(
      await errorCode(() => as("loner", (tx) => getProvision(tx, deps, org.user("loner"), r.projectId as string))),
    ).toBe("PROJECT_NOT_FOUND");
  });
});

describe("RLS projects, project_provision_steps", () => {
  it("không có context thì 0 dòng", async () => {
    await withTenant(app, {}, async (tx) => {
      expect(await tx.select().from(projects)).toHaveLength(0);
      expect(await tx.select().from(projectProvisionSteps)).toHaveLength(0);
    });
  });

  it("tổ chức khác không thấy dự án", async () => {
    await withTenant(app, { userId: other.user("owner"), orgId: other.orgId }, async (tx) => {
      expect(await tx.select().from(projects)).toHaveLength(0);
      expect(await tx.select().from(projectProvisionSteps)).toHaveLength(0);
    });
  });

  it("UPDATE không chuyển được dự án sang tổ chức khác", async () => {
    const r = await createProject(app, deps, actor("tadmin"), input());
    const code = await pgCode(() =>
      as("owner", (tx) =>
        tx
          .update(projects)
          .set({ orgId: other.orgId })
          .where(eq(projects.id, r.projectId as string)),
      ),
    );
    expect(code).toBe("42501");
  });

  it("không trỏ được tới hệ thống, đội hay kết nối của tổ chức khác (khoá ngoại)", async () => {
    const code = await pgCode(() =>
      as("owner", (tx) =>
        tx.insert(projects).values({
          orgId: org.orgId,
          teamId: other.teamId,
          systemId: other.systemId,
          key: "lan-sang",
          name: "x",
          scmConnectionId: connectionId,
          scmKind: "github",
          repoMode: "new",
          repoOwner: "x",
          repoName: "lan-sang",
          settings: {} as never,
          idempotencyKey: randomUUID(),
          createdBy: "x",
        }),
      ),
    );
    expect(code).toBe("23503");
  });

  it("team_id phải khớp đội sở hữu hệ thống", async () => {
    const code = await pgCode(() =>
      as("owner", (tx) =>
        tx.insert(projects).values({
          orgId: org.orgId,
          teamId: org.otherTeamId,
          systemId: org.systemId,
          key: "lech-doi",
          name: "x",
          scmConnectionId: connectionId,
          scmKind: "github",
          repoMode: "new",
          repoOwner: "x",
          repoName: "lech-doi",
          settings: {} as never,
          idempotencyKey: randomUUID(),
          createdBy: "x",
        }),
      ),
    );
    expect(code).toBe("23503");
  });

  it("kết nối Git đang có dự án dùng thì không xoá được", async () => {
    expect(await errorCode(() => as("owner", (tx) => removeConnection(tx, org.user("owner"), connectionId)))).toBe(
      "SCM_CONNECTION_IN_USE",
    );
  });
});

// Chạy cuối file: worker nhận cả job còn lại của các test trên (đều đã xong hoặc đang lỗi nên bỏ qua).
describe("qua pg-boss thật", () => {
  it("worker vai trò jobs nhận job và đưa dự án tới active", async () => {
    await registerProvisionWorker(jobs, sagaDeps, { pollingIntervalSeconds: 0.5 });
    const r = await createProject(app, deps, actor("tadmin"), input());
    const id = r.projectId as string;
    const deadline = Date.now() + 20_000;
    while ((await projectState(id)) !== "active" && Date.now() < deadline)
      await new Promise((ok) => setTimeout(ok, 200));
    expect(await projectState(id)).toBe("active");
  });
});

const JSON_HEADERS = { headers: { "content-type": "application/json" } };

/** Giả lập GitHub bằng MockAgent riêng (không dùng dispatcher toàn cục); mock-http của scm nằm ngoài index.ts. */
function mockHttp() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const fetch = async (input: string | URL | Request, init?: RequestInit) =>
    (await undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never)) as unknown as Response;
  return { agent, fetch };
}

describe("projects.create dryRun với kết nối GitHub chế độ token", () => {
  let tokenConnId = "";
  let http: ReturnType<typeof mockHttp>;
  beforeAll(async () => {
    const conn = await as("owner", (tx) =>
      createConnection(tx, masterKey, org.user("owner"), {
        kind: "github",
        authMode: "token",
        name: "GitHub token của đội",
        defaultOwner: "xdev-team",
        token: "github_pat_khong_dung_that",
      }),
    );
    tokenConnId = conn.id;
  });
  afterEach(async () => {
    http.agent.assertNoPendingInterceptors();
    await http.agent.close();
  });

  const tokenDeps = (): CatalogDeps => {
    http = mockHttp();
    return { ...deps, providerFactory: createProviderFactory({ fetch: http.fetch }) };
  };
  const repoInput = (owner: string) => {
    const i = input({ dryRun: true });
    return { ...i, repo: { ...i.repo, connectionId: tokenConnId, owner } } as typeof i;
  };

  it("fine-grained token trong org: kế hoạch đủ bước, cảnh báo quyền chưa kiểm được", async () => {
    const d = tokenDeps();
    const i = repoInput("xdev-team");
    const pool = http.agent.get("https://api.github.com");
    pool.intercept({ path: "/user", method: "GET" }).reply(200, { login: "duy" }, JSON_HEADERS);
    pool.intercept({ path: "/orgs/xdev-team", method: "GET" }).reply(200, { login: "xdev-team" }, JSON_HEADERS);
    pool
      .intercept({ path: `/repos/xdev-team/${i.repo.mode === "new" ? i.repo.name : ""}`, method: "GET" })
      .reply(404, { message: "Not Found" }, JSON_HEADERS);
    const r = await dryRunCreate(app, d, actor("tadmin"), i);
    expect(r).toMatchObject({ dryRun: true, projectId: null, state: "planned" });
    expect(r.steps.map((s) => s.kind)).toContain("create-repo");
    expect(r.warnings.map((w) => w.code)).toEqual(["SCOPES_UNVERIFIED"]);
  });

  it("PAT cổ điển, repo dưới tài khoản của chính chủ token: không cảnh báo", async () => {
    const d = tokenDeps();
    const i = repoInput("duy");
    const pool = http.agent.get("https://api.github.com");
    pool
      .intercept({ path: "/user", method: "GET" })
      .reply(200, { login: "duy" }, { headers: { "content-type": "application/json", "x-oauth-scopes": "repo" } });
    pool
      .intercept({ path: `/repos/duy/${i.repo.mode === "new" ? i.repo.name : ""}`, method: "GET" })
      .reply(404, { message: "Not Found" }, JSON_HEADERS);
    const r = await dryRunCreate(app, d, actor("tadmin"), i);
    expect(r.warnings).toEqual([]);
  });

  it("PAT cổ điển thiếu scope repo: cảnh báo ACCESS_MISSING", async () => {
    const d = tokenDeps();
    const i = repoInput("duy");
    const pool = http.agent.get("https://api.github.com");
    pool
      .intercept({ path: "/user", method: "GET" })
      .reply(200, { login: "duy" }, { headers: { "content-type": "application/json", "x-oauth-scopes": "" } });
    pool
      .intercept({ path: `/repos/duy/${i.repo.mode === "new" ? i.repo.name : ""}`, method: "GET" })
      .reply(404, { message: "Not Found" }, JSON_HEADERS);
    const r = await dryRunCreate(app, d, actor("tadmin"), i);
    expect(r.warnings.map((w) => w.code)).toEqual(["ACCESS_MISSING"]);
    expect(r.warnings[0]?.message).toContain("repo");
  });
});
