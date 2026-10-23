import { randomBytes, randomUUID } from "node:crypto";
import { type AgentPolicyInput, DEFAULT_AGENT_POLICY, DEFAULT_ORG_SDLC_POLICY } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { syncInstructionTemplates, templateService, updateProjectSettings } from "../catalog/index.ts";
import { assertSettingsUnlocked, setOrgEntry } from "../layers/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { purgeRunLogs } from "../runs/index.ts";
import { createMemoryProvider, type MemoryProvider } from "../scm/index.ts";
import { getAgentPolicy, loadPolicy, saveAgentPolicy, sdlcPolicyOf } from "./policies.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: Awaited<ReturnType<typeof seedOrg>>;
let project: Awaited<ReturnType<typeof seedProject>>;
let provider: MemoryProvider;

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

const policy = (patch: Partial<AgentPolicyInput> = {}): AgentPolicyInput => ({ ...DEFAULT_AGENT_POLICY, ...patch });

beforeAll(async () => {
  org = await seedOrg(admin, `pol-${tag}`);
  project = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `pol-${tag}`,
  });
  provider = createMemoryProvider("gitlab", ["xdev-team"]);
  provider.seedRepo({ owner: project.owner, name: project.repo }, { files: { "AGENTS.md": "cũ\n" } });
});

beforeEach(async () => {
  await admin.query("delete from hive.agent_policies where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.config_layer_entries where org_id = $1", [org.orgId]);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("lưu và đọc chính sách", () => {
  it("chưa lưu thì mọi thành viên đọc được mặc định, có mẫu chuẩn để hiện", async () => {
    const got = await as("tviewer", (tx) => getAgentPolicy(tx));
    expect(got).toMatchObject({ ...DEFAULT_AGENT_POLICY, updatedAt: null, templateSync: null });
    expect(got.defaultTemplates.agents).toContain("Hive project key: `{{project.key}}`");
  });

  it("thành viên và quản trị đội không sửa được; quản trị tổ chức sửa được, có audit trước và sau", async () => {
    for (const who of ["tmember", "tadmin"]) {
      expect(await errorCode(() => as(who, (tx) => saveAgentPolicy(tx, org.user(who), policy())))).toBe(
        "ORG_ROLE_REQUIRED",
      );
    }
    const next = policy({
      allowedModels: { claude: ["claude-sonnet-5-5"], codex: [], gemini: [] },
      neverAutoUpgrade: true,
      hooks: [{ event: "Stop", name: "Test nhanh", command: "pnpm check --affected" }],
      limits: { ...DEFAULT_AGENT_POLICY.limits, perRunUsd: 5 },
    });
    const saved = await as("admin", (tx) => saveAgentPolicy(tx, org.user("admin"), next));
    expect(saved.templatesChanged).toBe(false);
    expect(saved.policy).toMatchObject({ neverAutoUpgrade: true, updatedBy: org.user("admin") });
    expect((await as("tmember", (tx) => loadPolicy(tx))).limits.perRunUsd).toBe(5);
    const { rows } = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'policies.update' order by created_at desc limit 1",
      [org.orgId],
    );
    expect(rows[0].data.changed.sort()).toEqual(["allowedModels", "hooks", "limits", "neverAutoUpgrade"]);
    expect(rows[0].data.before.neverAutoUpgrade).toBe(false);
    expect(rows[0].data.after.hooks[0].command).toBe("pnpm check --affected");
  });

  it("mở lại toàn quyền CLI cần quyền của owner", async () => {
    await as("admin", (tx) => saveAgentPolicy(tx, org.user("admin"), policy({ allowFullPermission: false })));
    expect(
      await errorCode(() =>
        as("admin", (tx) => saveAgentPolicy(tx, org.user("admin"), policy({ allowFullPermission: true }))),
      ),
    ).toBe("POLICY_FULLACCESS_REQUIRED");
    await as("owner", (tx) => saveAgentPolicy(tx, org.user("owner"), policy({ allowFullPermission: true })));
    expect((await as("admin", (tx) => loadPolicy(tx))).allowFullPermission).toBe(true);
  });

  it("dự án không bật được toàn quyền khi tổ chức khoá cấu hình", async () => {
    await as("owner", (tx) => saveAgentPolicy(tx, org.user("owner"), policy({ allowFullPermission: false })));
    await as("owner", (tx) =>
      setOrgEntry(tx, org.user("owner"), { key: "agent.permissionMode", value: "workspace", locked: true }),
    );
    expect(
      await errorCode(() =>
        as("tadmin", (tx) =>
          updateProjectSettings(
            tx,
            org.user("tadmin"),
            `pol-${tag}`,
            { runPermissions: { mode: "full" } },
            assertSettingsUnlocked,
          ),
        ),
      ),
    ).toBe("CONFIG_LOCKED");
    const ok = await as("tadmin", (tx) =>
      updateProjectSettings(tx, org.user("tadmin"), `pol-${tag}`, { runPermissions: { mode: "workspace" } }),
    );
    expect(ok.runPermissions).toEqual({ mode: "workspace" });
  });

  it("RLS: tổ chức khác không thấy chính sách", async () => {
    await as("admin", (tx) => saveAgentPolicy(tx, org.user("admin"), policy({ requireSandbox: true })));
    const other = await seedOrg(admin, `pol2-${tag}`);
    const seen = await withTenant(app, { userId: other.user("admin"), orgId: other.orgId }, (tx) => loadPolicy(tx));
    expect(seen.requireSandbox).toBe(false);
  });
});

describe("chính sách AI SDLC", () => {
  it("chưa lưu, hoặc dòng cũ không có mục sdlc, thì dùng mặc định (tự duyệt được phép)", async () => {
    expect(await as("tmember", (tx) => sdlcPolicyOf(tx))).toEqual(DEFAULT_ORG_SDLC_POLICY);
    await as("admin", (tx) => saveAgentPolicy(tx, org.user("admin"), policy()));
    await admin.query("update hive.agent_policies set policy = policy - 'sdlc' where org_id = $1", [org.orgId]);
    expect((await as("tmember", (tx) => sdlcPolicyOf(tx))).autoApprove.allowed).toBe(true);
  });

  it("mục đã lưu thắng mặc định; tắt tự duyệt có hiệu lực ngay và có audit", async () => {
    const sdlc = { autoApprove: { ...DEFAULT_ORG_SDLC_POLICY.autoApprove, allowed: false, minScoreFloor: 9 } };
    await as("admin", (tx) => saveAgentPolicy(tx, org.user("admin"), policy({ sdlc })));
    const got = await as("tmember", (tx) => sdlcPolicyOf(tx));
    expect(got.autoApprove).toMatchObject({ allowed: false, minScoreFloor: 9 });
    const { rows } = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'policies.update' order by created_at desc limit 1",
      [org.orgId],
    );
    expect(rows[0].data.changed).toContain("sdlc");
  });

  it("RLS: tổ chức khác vẫn thấy mặc định", async () => {
    const sdlc = { autoApprove: { ...DEFAULT_ORG_SDLC_POLICY.autoApprove, allowed: false } };
    await as("admin", (tx) => saveAgentPolicy(tx, org.user("admin"), policy({ sdlc })));
    const other = await seedOrg(admin, `pol3-${tag}`);
    const seen = await withTenant(app, { userId: other.user("admin"), orgId: other.orgId }, (tx) => sdlcPolicyOf(tx));
    expect(seen.autoApprove.allowed).toBe(true);
  });
});

describe("mẫu file hướng dẫn agent", () => {
  const service = templateService({ publicUrl: "https://hive.example/" });

  it("xem trước điền biến của dự án; mẫu đang sửa thắng mẫu đã lưu", async () => {
    const preview = await as("admin", (tx) =>
      service.preview(
        tx,
        { agents: "# {{project.name}} ({{project.key}}) {{la}}", claude: null, mcp: null },
        `pol-${tag}`,
      ),
    );
    expect(preview.project.key).toBe(`pol-${tag}`);
    expect(preview.files.map((f) => f.path)).toEqual(["AGENTS.md", "CLAUDE.md", ".mcp.json"]);
    expect(preview.files[0]?.content).toBe(`# pol-${tag} (pol-${tag}) {{la}}`);
    expect(JSON.parse(preview.files[2]?.content ?? "{}").mcpServers["xdev-hive"].url).toBe("https://hive.example/mcp");
  });

  it("đồng bộ mở PR ở dự án khác mẫu, lần sau không commit lại", async () => {
    await as("admin", (tx) =>
      saveAgentPolicy(
        tx,
        org.user("admin"),
        policy({ templates: { agents: "# {{project.key}}\n\nĐọc tài liệu qua MCP.\n", claude: null, mcp: null } }),
      ),
    );
    const deps = {
      pool: app,
      masterKey,
      providerFactory: () => provider,
      publicUrl: "https://hive.example",
      pauseMs: 0,
    };
    const first = await syncInstructionTemplates(deps, org.orgId);
    expect(first).toMatchObject({ opened: 1, unchanged: 0, failed: [] });
    const pr = provider.calls.find((c) => c.method === "openPR")?.args[1] as { head: string; base: string };
    expect(pr).toMatchObject({ head: "hive/update-agent-instructions", base: "main" });
    const commits = provider.calls.filter((c) => c.method === "commitFiles").length;
    const second = await syncInstructionTemplates(deps, org.orgId);
    expect(second).toMatchObject({ opened: 0, unchanged: 1 });
    expect(provider.calls.filter((c) => c.method === "commitFiles").length).toBe(commits);
    expect((await as("admin", (tx) => getAgentPolicy(tx))).templateSync).toMatchObject({ opened: 0, unchanged: 1 });
  });
});

describe("giữ log run", () => {
  it("xoá log quá số ngày của từng tổ chức, chưa có chính sách thì giữ 365 ngày", async () => {
    await as("admin", (tx) =>
      saveAgentPolicy(
        tx,
        org.user("admin"),
        policy({ limits: { ...DEFAULT_AGENT_POLICY.limits, runLogRetentionDays: 30 } }),
      ),
    );
    const other = await seedOrg(admin, `pol3-${tag}`);
    const runIn = async (o: { orgId: string; teamId: string; user: (n: string) => string }, projectId: string) => {
      const task = await admin.query(
        `insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by)
         values ($1, $2, $3, 1, $4, 't', $5) returning id`,
        [o.orgId, o.teamId, projectId, `T-${randomUUID().slice(0, 6)}`, o.user("admin")],
      );
      const run = await admin.query(
        `insert into hive.runs (org_id, team_id, project_id, task_id, branch, policy_snapshot, created_by)
         values ($1, $2, $3, $4, 'ai/x', '[]', $5) returning id`,
        [o.orgId, o.teamId, projectId, task.rows[0].id, o.user("admin")],
      );
      return run.rows[0].id as string;
    };
    const otherProject = await seedProject(admin, app, {
      orgId: other.orgId,
      teamId: other.teamId,
      systemId: other.systemId,
      adminUserId: other.user("admin"),
      masterKey,
      key: `pol3-${tag}`,
    });
    const mine = await runIn(org, project.projectId);
    const theirs = await runIn(other, otherProject.projectId);
    const log = (orgId: string, runId: string, days: number, offset: number) =>
      admin.query(
        `insert into hive.run_logs (org_id, run_id, attempt, seq, "offset", data, created_at)
         values ($1, $2, 1, $3::int, $3::bigint, 'x', now() - make_interval(days => $4::int))`,
        [orgId, runId, offset, days],
      );
    await log(org.orgId, mine, 40, 0);
    await log(org.orgId, mine, 10, 1);
    await log(other.orgId, theirs, 100, 0);
    await purgeRunLogs(app);
    const left = await admin.query(
      `select org_id, "offset" from hive.run_logs where run_id = any($1::uuid[]) order by org_id, "offset"`,
      [[mine, theirs]],
    );
    expect(left.rows.filter((r) => r.org_id === org.orgId).map((r) => Number(r.offset))).toEqual([1]);
    expect(left.rows.filter((r) => r.org_id === other.orgId)).toHaveLength(1);
  });
});
