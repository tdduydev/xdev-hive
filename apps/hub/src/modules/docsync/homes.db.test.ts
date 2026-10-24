import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import {
  createPool,
  decryptSecret,
  ForbiddenError,
  type Jobs,
  NotFoundError,
  parseMasterKey,
  withTenant,
} from "../platform/index.ts";
import { createMemoryProvider, GitProviderError } from "../scm/index.ts";
import { sdlcManagedPaths } from "../sdlc/index.ts";
import {
  changeHomeState,
  configureOrgHome,
  configureProjectHome,
  ensureProjectInclude,
  getHome,
  homeById,
  homeSecretContext,
  homeView,
  removeHome,
} from "./homes.ts";
import { DOCSYNC_PULL_QUEUE } from "./jobs.ts";
import { handleDocsWebhook } from "./webhook.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const mem = createMemoryProvider("gitlab", ["xdev-team"]);
const queued: Array<{ queue: string; data: unknown }> = [];
const jobs = {
  enqueue: async (queue: string, data: object) => {
    queued.push({ queue, data });
    return randomUUID();
  },
} as unknown as Jobs;
const deps = { pool, jobs, masterKey, providerFactory: () => mem, publicUrl: "https://hive.example" };

let org: Awaited<ReturnType<typeof seedOrg>>;
let project: Awaited<ReturnType<typeof seedProject>>;
let sdlcProject: Awaited<ReturnType<typeof seedProject>>;
const keys = { main: `dh${tag}`, sdlc: `ds${tag}` };
const actor = (name: string) => ({ userId: org.user(name), orgId: org.orgId });
const as = <T>(name: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, actor(name), fn);
const settings = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  root: "docs/",
  repoSync: "pr" as const,
  include: ["**/*.md"],
  exclude: [],
  assetsDir: "assets",
  repoChangesNeedReview: false,
  wordImportConfidential: false,
  ...over,
});
const projectRef = () => ({ owner: project.owner, name: project.repo });
const configureMain = (who: string, over: Record<string, unknown> = {}) =>
  as(who, (tx) => configureProjectHome(tx, deps, actor(who), { project: keys.main, settings: settings(over) }));
const orgInput = (over: Record<string, unknown> = {}) => ({
  connectionId: project.connectionId,
  owner: "xdev-team",
  name: `org-docs-${tag}`,
  create: true,
  root: "",
  assetsDir: "assets",
  mode: "pr" as const,
  include: ["**/*.md"],
  exclude: [],
  repoChangesNeedReview: false,
  ...over,
});

beforeAll(async () => {
  org = await seedOrg(admin, `dh-${tag}`);
  const base = {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
  };
  project = await seedProject(admin, pool, { ...base, key: keys.main });
  sdlcProject = await seedProject(admin, pool, {
    ...base,
    key: keys.sdlc,
    settings: { ...defaultProjectSettings(), sdlc: { docsRoot: "specs" } } as never,
  });
  mem.seedRepo(projectRef(), { files: { "docs/a.md": "# A\n" } });
  mem.seedRepo({ owner: sdlcProject.owner, name: sdlcProject.repo }, { files: { "specs/a.md": "# S\n" } });
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe("nhà tài liệu của dự án", () => {
  it("chỉ quản trị dự án mới cấu hình; thành viên đội thường bị chặn", async () => {
    await expect(configureMain("tmember")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(configureMain("loner")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lưu nhà, ghi settings.docs của dự án và audit", async () => {
    const row = await configureMain("tadmin");
    expect(row).toMatchObject({
      scope: "project",
      projectId: project.projectId,
      branch: "main",
      mode: "pr",
      status: "active",
    });
    const { rows } = await admin.query("select settings->'docs' as docs from hive.projects where id = $1", [
      project.projectId,
    ]);
    expect(rows[0].docs).toMatchObject({ enabled: true, root: "docs/" });
    const audit = await admin.query(
      "select 1 from hive.audit_log where org_id = $1 and action = 'doc.home_configure'",
      [org.orgId],
    );
    expect(audit.rowCount).toBe(1);
    expect(homeView(row, deps)).toMatchObject({ webhookUrl: null });
    expect(await as("tmember", (tx) => getHome(tx, org.user("tmember"), keys.main))).toMatchObject({ id: row.id });
  });

  it("ghi và đọc lại tài liệu mật khi nhập Word (Q15)", async () => {
    const on = await configureMain("tadmin", { wordImportConfidential: true });
    expect(on.wordImportConfidential).toBe(true);
    expect(homeView(on, deps).wordImportConfidential).toBe(true);
    const { rows } = await admin.query("select settings->'docs' as docs from hive.projects where id = $1", [
      project.projectId,
    ]);
    expect(rows[0].docs).toMatchObject({ wordImportConfidential: true });
    const off = await configureMain("tadmin");
    expect(homeView(off, deps).wordImportConfidential).toBe(false);
  });

  it("kết nối thiếu quyền thì báo DOCSYNC_NO_ACCESS", async () => {
    mem.fail("getRepo", new GitProviderError("forbidden", "gitlab: 403", { status: 403 }));
    await expect(configureMain("tadmin", { root: "tai-lieu/" })).rejects.toMatchObject({ code: "DOCSYNC_NO_ACCESS" });
    mem.fail("getRepo", null);
  });

  it("thư mục chồng với SDLC của dự án thì báo trùng; tắt thì nhà tạm dừng", async () => {
    await expect(
      as("admin", (tx) =>
        configureProjectHome(tx, deps, actor("admin"), { project: keys.sdlc, settings: settings({ root: "specs/" }) }),
      ),
    ).rejects.toMatchObject({ code: "DOCSYNC_HOME_OVERLAP" });
    expect(await as("admin", (tx) => sdlcManagedPaths(tx, sdlcProject.projectId))).toEqual(["specs"]);
    // Bỏ khoá ngoại để khỏi dựng cả hạng mục SDLC; chỉ cần dòng đồng bộ có đường dẫn.
    const client = await admin.connect();
    try {
      await client.query("set session_replication_role = replica");
      await client.query(
        "insert into hive.sdlc_artifact_syncs (org_id, artifact_id, project_id, kind, repo_path) values ($1, $2, $3, 'source', 'tai-lieu/spec.md')",
        [org.orgId, randomUUID(), sdlcProject.projectId],
      );
    } finally {
      client.release();
    }
    expect(await as("admin", (tx) => sdlcManagedPaths(tx, sdlcProject.projectId))).toEqual([
      "specs",
      "tai-lieu/spec.md",
    ]);
    await expect(
      as("admin", (tx) =>
        configureProjectHome(tx, deps, actor("admin"), {
          project: keys.sdlc,
          settings: settings({ root: "tai-lieu/" }),
        }),
      ),
    ).rejects.toMatchObject({ code: "DOCSYNC_HOME_OVERLAP" });
    const off = await configureMain("tadmin", { enabled: false });
    expect(off).toMatchObject({ mode: "off", status: "paused", statusReason: "disabled" });
    const on = await configureMain("tadmin");
    expect(on).toMatchObject({ mode: "pr", status: "active", statusReason: null });
  });

  it("pause, resume và acceptBranch khi nhánh mặc định đổi", async () => {
    const home = await configureMain("tadmin");
    const paused = await as("tadmin", (tx) => changeHomeState(tx, deps, actor("tadmin"), home.id, "pause"));
    expect(paused).toMatchObject({ status: "paused", statusReason: "manual" });
    queued.length = 0;
    const resumed = await as("tadmin", (tx) => changeHomeState(tx, deps, actor("tadmin"), home.id, "resume"));
    expect(resumed).toMatchObject({ status: "active", statusReason: null });
    expect(queued.some((job) => job.queue === DOCSYNC_PULL_QUEUE)).toBe(true);

    const repo = mem.repos.get(`${project.owner}/${project.repo}`.toLowerCase());
    if (!repo) throw new Error("thiếu repo giả");
    repo.info.defaultBranch = "develop";
    repo.branches.set("develop", new Map(repo.branches.get("main")));
    await expect(
      as("tadmin", (tx) => changeHomeState(tx, deps, actor("tadmin"), home.id, "resume")),
    ).rejects.toMatchObject({
      code: "DOCSYNC_PAUSED",
    });
    await expect(
      as("tadmin", (tx) => changeHomeState(tx, deps, actor("tadmin"), home.id, "acceptBranch", "main")),
    ).rejects.toMatchObject({ code: "DOCSYNC_PAUSED" });
    const accepted = await as("tadmin", (tx) =>
      changeHomeState(tx, deps, actor("tadmin"), home.id, "acceptBranch", "develop"),
    );
    expect(accepted).toMatchObject({ branch: "develop", status: "active", lastCommit: null });
  });
});

describe("ensureProjectInclude (thư mục TC, specs/036 D3b)", () => {
  const ensure = (projectId: string, glob: string) =>
    as("tadmin", (tx) => ensureProjectInclude(tx, actor("tadmin"), projectId, glob, { jobs }));
  const included = async () =>
    (
      await admin.query(
        "select h.include, p.settings->'docs'->'include' as docs from hive.doc_homes h join hive.projects p on p.id = h.project_id where h.project_id = $1",
        [project.projectId],
      )
    ).rows[0];

  it("dự án chưa có nhà thì báo no-home", async () => {
    expect(await ensure(sdlcProject.projectId, "specs/test-cases/**")).toBe("no-home");
  });

  it("include đã phủ thì không đổi gì", async () => {
    await configureMain("tadmin", { include: ["docs/**"] });
    queued.length = 0;
    expect(await ensure(project.projectId, "docs/test-cases/**")).toBe("covered");
    expect(queued).toHaveLength(0);
    expect((await included()).include).toEqual(["docs/**"]);
  });

  it("chưa phủ thì thêm glob vào nhà và settings.docs, ghi audit, xếp một lần kéo", async () => {
    queued.length = 0;
    expect(await ensure(project.projectId, "kiem-thu/test-cases/**")).toBe("added");
    expect(await included()).toEqual({
      include: ["docs/**", "kiem-thu/test-cases/**"],
      docs: ["docs/**", "kiem-thu/test-cases/**"],
    });
    expect(queued.filter((job) => job.queue === DOCSYNC_PULL_QUEUE)).toHaveLength(1);
    const audit = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'doc.home_include_add'",
      [org.orgId],
    );
    expect(audit.rows.map((r) => r.data)).toEqual([{ projectId: project.projectId, glob: "kiem-thu/test-cases/**" }]);
    expect(await ensure(project.projectId, "kiem-thu/test-cases/**")).toBe("covered");
    await configureMain("tadmin");
  });
});

describe("nhà tài liệu của tổ chức", () => {
  it("chỉ quản trị tổ chức mới cấu hình", async () => {
    await expect(as("tadmin", (tx) => configureOrgHome(tx, deps, actor("tadmin"), orgInput()))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("tạo repo kèm README, gắn webhook và mã hoá secret", async () => {
    const row = await as("admin", (tx) => configureOrgHome(tx, deps, actor("admin"), orgInput()));
    expect(row).toMatchObject({ scope: "org", projectId: null, branch: "main", status: "active" });
    const repo = mem.repos.get(`xdev-team/org-docs-${tag}`);
    expect(repo?.branches.get("main")?.get("README.md")).toContain("Tài liệu tổ chức");
    const [hook] = [...(repo?.hooks.values() ?? [])];
    expect(hook).toMatchObject({ url: `https://hive.example/hooks/docs/${row.id}`, events: ["push"] });
    expect(row.webhookSecretEnc).not.toContain(hook?.secret ?? "?");
    expect(decryptSecret(masterKey, row.webhookSecretEnc as string, homeSecretContext(row.id))).toBe(hook?.secret);
    expect(homeView(row, deps).webhookUrl).toBe(`https://hive.example/hooks/docs/${row.id}`);
    expect(homeView(row, deps).wordImportConfidential).toBe(false);
    const confidential = await as("admin", (tx) =>
      configureOrgHome(tx, deps, actor("admin"), orgInput({ create: false, wordImportConfidential: true })),
    );
    expect(homeView(confidential, deps).wordImportConfidential).toBe(true);
  });

  it("thư mục chồng với nhà dự án cùng repo hoặc với kho skill thì báo trùng", async () => {
    await expect(
      as("admin", (tx) =>
        configureOrgHome(
          tx,
          deps,
          actor("admin"),
          orgInput({ owner: project.owner, name: project.repo, create: false, root: "docs/sub" }),
        ),
      ),
    ).rejects.toMatchObject({ code: "DOCSYNC_HOME_OVERLAP" });
    await admin.query(
      "insert into hive.skill_repos (org_id, connection_id, owner, name, branch, webhook_secret_enc, configured_by) values ($1, $2, $3, $4, 'main', 'x', $5)",
      [org.orgId, project.connectionId, "xdev-team", `skills-${tag}`, org.user("admin")],
    );
    mem.seedRepo({ owner: "xdev-team", name: `skills-${tag}` });
    await expect(
      as("admin", (tx) =>
        configureOrgHome(tx, deps, actor("admin"), orgInput({ name: `skills-${tag}`, create: false })),
      ),
    ).rejects.toMatchObject({ code: "DOCSYNC_HOME_OVERLAP" });
    await admin.query("delete from hive.skill_repos where org_id = $1", [org.orgId]);
  });

  it("đổi repo khi đã có tài liệu ánh xạ thì bị chặn", async () => {
    const home = await as("admin", (tx) => getHome(tx, org.user("admin")));
    if (!home) throw new Error("thiếu nhà tổ chức");
    const docId = randomUUID();
    await admin.query(
      "insert into hive.docs (id, org_id, key, title, current_version, updated_by_user_id) values ($1, $2, 'org/x', 'X', 1, $3)",
      [docId, org.orgId, org.user("admin")],
    );
    await admin.query(
      "insert into hive.doc_repo_files (org_id, home_id, doc_id, repo_path) values ($1, $2, $3, 'x.md')",
      [org.orgId, home.id, docId],
    );
    mem.seedRepo({ owner: "xdev-team", name: `other-${tag}` });
    await expect(
      as("admin", (tx) =>
        configureOrgHome(tx, deps, actor("admin"), orgInput({ name: `other-${tag}`, create: false })),
      ),
    ).rejects.toMatchObject({ code: "DOCSYNC_HOME_OVERLAP" });
  });
});

describe("webhook /hooks/docs/{homeId}", () => {
  let homeId: string;
  let secret: string;
  beforeAll(async () => {
    const home = await as("admin", (tx) => getHome(tx, org.user("admin")));
    if (!home?.webhookSecretEnc) throw new Error("thiếu nhà tổ chức");
    homeId = home.id;
    secret = decryptSecret(masterKey, home.webhookSecretEnc, homeSecretContext(home.id));
  });
  const github = (event: string, delivery: string, body = "{}", key = secret) =>
    new Request(`https://hive.example/hooks/docs/${homeId}`, {
      method: "POST",
      body,
      headers: {
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${createHmac("sha256", key).update(body).digest("hex")}`,
      },
    });

  it("chữ ký sai hoặc nhà không có thì 401, không xếp việc", async () => {
    queued.length = 0;
    expect((await handleDocsWebhook(deps, homeId, github("push", "d-bad", "{}", "sai"))).status).toBe(401);
    expect((await handleDocsWebhook(deps, randomUUID(), github("push", "d-none"))).status).toBe(401);
    expect((await handleDocsWebhook(deps, "khong-phai-uuid", github("push", "d-none"))).status).toBe(401);
    expect(queued).toHaveLength(0);
  });

  it("push hợp lệ xếp một lần kéo cho nhà", async () => {
    queued.length = 0;
    const response = await handleDocsWebhook(deps, homeId, github("push", `d-${tag}-1`));
    expect(response.status).toBe(202);
    expect(queued).toEqual([{ queue: DOCSYNC_PULL_QUEUE, data: { orgId: org.orgId, homeId } }]);
  });

  it("ping trả 204; sự kiện khác không xếp việc", async () => {
    queued.length = 0;
    expect((await handleDocsWebhook(deps, homeId, github("ping", `d-${tag}-p`))).status).toBe(204);
    expect(await (await handleDocsWebhook(deps, homeId, github("issues", `d-${tag}-i`))).json()).toEqual({
      status: "ignored",
    });
    expect(queued).toHaveLength(0);
  });

  it("GitLab gửi token trần trong X-Gitlab-Token", async () => {
    queued.length = 0;
    const request = (token: string) =>
      new Request(`https://hive.example/hooks/docs/${homeId}`, {
        method: "POST",
        body: "{}",
        headers: { "x-gitlab-event": "Push Hook", "x-gitlab-token": token, "idempotency-key": `g-${tag}` },
      });
    expect((await handleDocsWebhook(deps, homeId, request("sai"))).status).toBe(401);
    expect((await handleDocsWebhook(deps, homeId, request(secret))).status).toBe(202);
    expect(queued).toHaveLength(1);
  });

  it("nhà tạm dừng thì chỉ ghi nhận", async () => {
    await as("admin", (tx) => changeHomeState(tx, deps, actor("admin"), homeId, "pause"));
    queued.length = 0;
    expect((await handleDocsWebhook(deps, homeId, github("push", `d-${tag}-z`))).status).toBe(202);
    expect(queued).toHaveLength(0);
    await as("admin", (tx) => changeHomeState(tx, deps, actor("admin"), homeId, "resume"));
  });
});

describe("gỡ nhà", () => {
  it("gỡ webhook, xoá nhà nhưng giữ tài liệu của hub", async () => {
    const home = await as("admin", (tx) => getHome(tx, org.user("admin")));
    if (!home) throw new Error("thiếu nhà tổ chức");
    const repo = mem.repos.get(`xdev-team/org-docs-${tag}`);
    expect(repo?.hooks.size).toBe(1);
    await expect(as("tadmin", (tx) => removeHome(tx, deps, actor("tadmin"), home.id))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await as("admin", (tx) => removeHome(tx, deps, actor("admin"), home.id));
    expect(repo?.hooks.size).toBe(0);
    await expect(as("admin", (tx) => homeById(tx, home.id))).rejects.toMatchObject({ code: "DOCSYNC_HOME_NOT_FOUND" });
    const { rowCount } = await admin.query("select 1 from hive.docs where org_id = $1 and key = 'org/x'", [org.orgId]);
    expect(rowCount).toBe(1);
  });

  it("gỡ nhà dự án thì settings.docs.enabled về false", async () => {
    const home = await as("tadmin", (tx) => getHome(tx, org.user("tadmin"), keys.main));
    if (!home) throw new Error("thiếu nhà dự án");
    await as("tadmin", (tx) => removeHome(tx, deps, actor("tadmin"), home.id));
    const { rows } = await admin.query(
      "select settings->'docs'->>'enabled' as enabled from hive.projects where id = $1",
      [project.projectId],
    );
    expect(rows[0].enabled).toBe("false");
  });
});
