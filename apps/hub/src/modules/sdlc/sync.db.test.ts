import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, projectSdlcSettings } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { saveDoc } from "../knowledge/index.ts";
import { createPool, type EnqueueOptions, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import {
  createMemoryProvider,
  GitProviderError,
  type MemoryProvider,
  type MemoryRepo,
  type ScmEventContext,
} from "../scm/index.ts";
import { createContract } from "./contracts.ts";
import { importItem } from "./import.ts";
import { createItem } from "./items.ts";
import { onBaseline } from "./phases.ts";
import {
  copyHeader,
  onSdlcPush,
  PULL_DEBOUNCE_MS,
  pullProject,
  requestSync,
  SDLC_PULL_CRON,
  SDLC_PULL_QUEUE,
  SDLC_SYNC_QUEUE,
  SYNC_DEBOUNCE_MS,
  type SyncDeps,
  scanProjects,
  syncItemProject,
} from "./sync.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let teamC = "";
const p: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };
const conn: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };
const key = (k: "a" | "b" | "c") => `${k}${tag}`;
const repoRef = (k: "a" | "b" | "c") => ({ owner: "xdev-team", name: `repo-${key(k)}` });

let mem: MemoryProvider;
/** Provider riêng cho repo b ở ca lỗi quyền: `fail` của memory provider áp cho mọi repo của nó. */
let memB: MemoryProvider | null = null;
let queued: { queue: string; data: Record<string, unknown>; opts: EnqueueOptions | undefined }[] = [];
let merges: unknown[] = [];

const jobs: Jobs = {
  start: async () => {},
  stop: async () => {},
  schedule: async () => {},
  work: async () => {},
  enqueue: async (queue, data, opts) => {
    queued.push({ queue, data: data as Record<string, unknown>, opts });
    return randomUUID();
  },
};

const deps = (): SyncDeps => ({
  pool: app,
  jobs,
  masterKey,
  publicUrl: "https://hive.test",
  providerFactory: (c) => (memB && c.id === conn.b ? memB : mem),
  enqueueMerge: async (_tx, input) => void merges.push(input),
});

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

const repoOf = (k: "a" | "b" | "c", m: MemoryProvider = mem): MemoryRepo => {
  const r = m.repos.get(`xdev-team/repo-${key(k)}`);
  if (!r) throw new Error(`thiếu repo ${k}`);
  return r;
};
const mainOf = (k: "a" | "b" | "c") => repoOf(k).branches.get("main") ?? new Map<string, string>();

async function seedSdlcProject(k: "a" | "b" | "c", teamId: string, systemId: string) {
  const base = defaultProjectSettings();
  const seeded = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId,
    systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: key(k),
    settings: {
      ...base,
      features: { ...base.features, mergeQueue: k !== "c" },
      sdlc: projectSdlcSettings.parse({ enabled: true, defaultMode: "speckit" }),
    },
  });
  p[k] = seeded.projectId;
  conn[k] = seeded.connectionId;
}

/** Hạng mục ba dự án của ba đội, a là dự án chính; contract do a cung cấp, b và c dùng. */
async function newItem() {
  const item = await as("admin", (tx) =>
    createItem(tx, org.user("admin"), {
      projectId: p.a,
      participants: [p.b, p.c],
      title: "Hoàn tiền một phần",
      idea: "Khách hàng được hoàn một phần tiền đơn hàng qua web và app.",
      modeRef: "speckit",
      size: "M",
    }),
  );
  const contract = await as("admin", (tx) =>
    createContract(tx, org.user("admin"), {
      itemId: item.id,
      name: "refund-api",
      format: "openapi",
      providerProjectId: p.a,
      consumerProjectIds: [p.b, p.c],
    }),
  );
  const spec = item.artifacts.find((a) => a.artifactId === "spec");
  if (!spec) throw new Error("speckit không còn spec");
  return { item, spec, contract, copyPath: `specs/${key("a")}-001-${item.slug}/contracts/refund-api.yaml` };
}

async function baseline(docKey: string, content: string) {
  await as("admin", async (tx) => {
    const doc = await saveDoc(
      tx,
      { kind: "user", userId: org.user("admin") },
      { key: docKey, content, baseVersion: 0 },
    );
    await onBaseline(tx, { docKey, version: doc.version, proposalId: randomUUID(), reviewId: randomUUID() }, { jobs });
  });
}

async function setRepoSync(itemId: string, mode: "pr" | "direct" | "off", projectId?: string) {
  await admin.query(
    `update hive.sdlc_item_projects set settings = jsonb_set(settings, '{repoSync}', to_jsonb($2::text))
     where item_id = $1 and ($3::uuid is null or project_id = $3)`,
    [itemId, mode, projectId ?? null],
  );
}

async function syncRows(itemId: string, projectId: string) {
  const { rows } = await admin.query(
    `select s.repo_path as "path", s.kind, s.sync_state as "state", s.synced_version as "version",
       s.sync_attempts as "attempts", s.sync_error as "error", s.pr_url as "prUrl", s.synced_commit as "commit"
     from hive.sdlc_artifact_syncs s join hive.sdlc_artifacts a on a.id = s.artifact_id
     where a.item_id = $1 and s.project_id = $2 and a.baseline_version is not null order by s.repo_path`,
    [itemId, projectId],
  );
  return rows as {
    path: string;
    kind: string;
    state: string;
    version: number | null;
    attempts: number;
    error: string | null;
    prUrl: string | null;
    commit: string | null;
  }[];
}

async function proposals() {
  const { rows } = await admin.query(
    "select target, content, reason, author_user_id as author from hive.proposals where org_id = $1 order by created_at",
    [org.orgId],
  );
  return rows as { target: string; content: string; reason: string; author: string }[];
}

/** Người khác push lên nhánh mặc định của repo (sửa, thêm, xoá file). */
function pushToMain(k: "a" | "b" | "c", files: Record<string, string | null>) {
  const repo = repoOf(k);
  const main = repo.branches.get("main");
  const write: { path: string; content: string }[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (content === null) main?.delete(path);
    else write.push({ path, content });
  }
  // Commit (kể cả rỗng) để đầu nhánh đổi sha như push thật.
  return mem.commitFiles(repoRef(k), { branch: "main", message: "chore: sửa tay", files: write });
}

beforeAll(async () => {
  org = await seedOrg(admin, `sds-${tag}`);
  teamC = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 'mobile', 'Mobile') returning id", [
      org.orgId,
    ])
  ).rows[0].id;
  const systemC = (
    await admin.query(
      "insert into hive.systems (org_id, team_id, slug, name) values ($1, $2, 'app', 'App') returning id",
      [org.orgId, teamC],
    )
  ).rows[0].id;
  await seedSdlcProject("a", org.teamId, org.systemId);
  await seedSdlcProject("b", org.otherTeamId, org.otherSystemId);
  await seedSdlcProject("c", teamC, systemC);
});

beforeEach(async () => {
  await admin.query("delete from hive.sdlc_items where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.proposals where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.doc_drafts where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.docs where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.inbox_items where org_id = $1", [org.orgId]);
  await admin.query("update hive.projects set webhook_secret_enc = null where org_id = $1", [org.orgId]);
  mem = createMemoryProvider("gitlab");
  memB = null;
  for (const k of ["a", "b", "c"] as const) mem.seedRepo(repoRef(k));
  queued = [];
  merges = [];
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("hub → repo", () => {
  it("baseline xếp job gộp 10 s cho mỗi repo; cách pr: một commit trên nhánh hive/sdlc, PR, status, vào hàng merge", async () => {
    const { item, spec, contract, copyPath } = await newItem();
    await baseline(spec.docKey, "# Spec\n");
    await baseline(contract.docKey, "openapi: 3.1.0\n");
    const syncJobs = queued.filter((q) => q.queue === SDLC_SYNC_QUEUE);
    expect(new Set(syncJobs.map((q) => q.opts?.singletonKey))).toEqual(
      new Set([p.a, p.b, p.c].map((id) => `${item.id}:${id}`)),
    );
    expect(syncJobs.every((q) => (q.opts?.startAfter?.getTime() ?? 0) > Date.now() + SYNC_DEBOUNCE_MS - 5_000)).toBe(
      true,
    );

    for (const k of ["a", "b", "c"] as const)
      expect(await syncItemProject(deps(), { orgId: org.orgId, itemId: item.id, projectId: p[k] })).toBe("synced");

    // Dự án chính: spec và contract nguồn trong một commit, chưa vào nhánh mặc định trước khi PR merge.
    const a = repoOf("a");
    const branchA = `hive/sdlc/001-${item.slug}`;
    expect(a.commits).toHaveLength(1);
    expect(a.commits[0]).toMatchObject({ branch: branchA });
    expect(a.commits[0]?.paths.sort()).toEqual([spec.repoPath, contract.repoPath].sort());
    expect(a.commits[0]?.message).toContain(`Hive-Sdlc-Item: ${item.id}`);
    expect(a.commits[0]?.message).toContain(`Co-authored-by: ${org.user("admin")} <${org.user("admin")}@seed.test>`);
    expect(a.branches.get(branchA)?.get(spec.repoPath)).toBe("# Spec\n");
    expect(mainOf("a").has(spec.repoPath)).toBe(false);
    expect(a.pulls).toEqual([expect.objectContaining({ head: branchA, base: "main", state: "open" })]);
    const sha = a.commits[0]?.sha ?? "";
    expect(a.statuses.get(sha)?.get("xdev-hive/sdlc")).toMatchObject({ state: "success" });

    // Repo bên dùng: chỉ bản sao có dòng đầu, kèm README mục lục.
    const b = repoOf("b");
    const branchB = `hive/sdlc/${key("a")}-001-${item.slug}`;
    const filesB = b.branches.get(branchB);
    expect(filesB?.get(copyPath)).toBe(`${copyHeader("openapi", key("a"))}\nopenapi: 3.1.0\n`);
    expect(filesB?.has(spec.repoPath)).toBe(false);
    const readme = filesB?.get(copyPath.replace("refund-api.yaml", "README.md")) ?? "";
    expect(readme).toContain(`dự án chính ${key("a")}`);
    expect(readme).toContain("https://hive.test/sdlc/");
    expect(repoOf("c").branches.get(branchB)?.get(copyPath)).toContain("openapi: 3.1.0");

    expect(await syncRows(item.id, p.a)).toEqual(
      [spec.repoPath, contract.repoPath].sort().map((path) =>
        expect.objectContaining({
          path,
          kind: "source",
          state: "synced",
          version: 1,
          commit: sha,
          prUrl: a.pulls[0]?.url,
        }),
      ),
    );
    // c tắt hàng merge: PR chờ người merge.
    expect(merges).toEqual(
      [p.a, p.b].map((projectId) =>
        expect.objectContaining({ projectId, runId: null, by: "system:sdlc", prNumber: 1 }),
      ),
    );
    // Không còn dòng chờ thì job không làm gì.
    expect(await syncItemProject(deps(), { orgId: org.orgId, itemId: item.id, projectId: p.a })).toBe("skipped");
  });

  it("direct ghi thẳng nhánh mặc định không mở PR; off không ghi gì", async () => {
    const { item, spec, contract, copyPath } = await newItem();
    await setRepoSync(item.id, "direct", p.a);
    await setRepoSync(item.id, "off", p.b);
    await baseline(spec.docKey, "# Spec\n");
    await baseline(contract.docKey, "openapi: 3.1.0\n");
    expect(queued.filter((q) => q.queue === SDLC_SYNC_QUEUE).map((q) => q.data.projectId)).not.toContain(p.b);

    expect(await syncItemProject(deps(), { orgId: org.orgId, itemId: item.id, projectId: p.a })).toBe("synced");
    expect(mainOf("a").get(spec.repoPath)).toBe("# Spec\n");
    expect(repoOf("a").pulls).toEqual([]);
    expect(merges).toEqual([]);

    expect(await syncItemProject(deps(), { orgId: org.orgId, itemId: item.id, projectId: p.b })).toBe("skipped");
    expect(repoOf("b").commits).toEqual([]);
    expect(await syncRows(item.id, p.b)).toEqual([expect.objectContaining({ path: copyPath, state: "none" })]);
    expect(
      await errorCode(() =>
        as("admin", (tx) => requestSync(tx, org.user("admin"), { id: item.id, projectId: p.b, action: "retry" })),
      ),
    ).toBe("SDLC_SYNC_OFF");
  });

  it("lỗi quyền ở một repo không chặn repo khác; ghi lỗi, hẹn lại, báo quản trị một lần; đồng bộ lại thì qua", async () => {
    const { item, spec, contract, copyPath } = await newItem();
    await baseline(spec.docKey, "# Spec\n");
    await baseline(contract.docKey, "openapi: 3.1.0\n");
    memB = createMemoryProvider("gitlab");
    memB.seedRepo(repoRef("b"));
    memB.fail("commitFiles", new GitProviderError("forbidden", "Token không có quyền ghi repo.", { status: 403 }));
    queued = [];

    const run = (k: "a" | "b" | "c") => syncItemProject(deps(), { orgId: org.orgId, itemId: item.id, projectId: p[k] });
    expect(await run("b")).toBe("failed");
    expect(await run("a")).toBe("synced");
    expect(await run("c")).toBe("synced");
    expect(await syncRows(item.id, p.b)).toEqual([
      expect.objectContaining({
        path: copyPath,
        state: "failed",
        attempts: 1,
        error: "Token không có quyền ghi repo.",
      }),
    ]);
    const retry = queued.find((q) => q.queue === SDLC_SYNC_QUEUE && q.data.projectId === p.b);
    expect((retry?.opts?.startAfter?.getTime() ?? 0) - Date.now()).toBeGreaterThan(50_000);

    expect(await run("b")).toBe("failed");
    expect((await syncRows(item.id, p.b))[0]?.attempts).toBe(2);
    const { rows: inbox } = await admin.query(
      "select user_id, title from hive.inbox_items where org_id = $1 and event = 'sdlc.sync_failed'",
      [org.orgId],
    );
    // Quản trị đội giữ repo b được báo, một lần dù lỗi hai lần; thành viên đội khác thì không.
    const who = inbox.map((r) => r.user_id as string);
    expect(who).toContain(org.user("oadmin"));
    expect(who).not.toContain(org.user("tmember"));
    expect(new Set(who).size).toBe(who.length);
    expect(inbox[0]?.title).toContain(key("b"));

    // Thành viên không phải quản trị đội không đồng bộ lại được; quản trị sửa quyền rồi bấm thì qua.
    expect(
      await errorCode(() =>
        as("tmember", (tx) => requestSync(tx, org.user("tmember"), { id: item.id, projectId: p.a, action: "retry" })),
      ),
    ).toBe("SDLC_FORBIDDEN");
    queued = [];
    const after = await as("oadmin", (tx) =>
      requestSync(tx, org.user("oadmin"), { id: item.id, projectId: p.b, action: "retry" }, { jobs }),
    );
    expect(after).toEqual([expect.objectContaining({ state: "pending", attempts: 0, error: null })]);
    expect(queued).toEqual([
      expect.objectContaining({ queue: SDLC_SYNC_QUEUE, data: { orgId: org.orgId, itemId: item.id, projectId: p.b } }),
    ]);
    memB.fail("commitFiles", null);
    expect(await run("b")).toBe("synced");
    expect((await syncRows(item.id, p.b))[0]).toMatchObject({ state: "synced", attempts: 0, error: null });
  });

  it("ghi đè repo bằng baseline đặt lại mọi dòng, kể cả dòng đã đồng bộ", async () => {
    const { item, spec } = await newItem();
    await baseline(spec.docKey, "# Spec\n");
    await syncItemProject(deps(), { orgId: org.orgId, itemId: item.id, projectId: p.a });
    const out = await as("tadmin", (tx) =>
      requestSync(tx, org.user("tadmin"), { id: item.id, projectId: p.a, action: "overwrite-repo" }, { jobs }),
    );
    expect(out.find((s) => s.repoPath === spec.repoPath)).toMatchObject({ state: "pending" });
    const { rows } = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'sdlc.sync.overwrite' and target_id = $2",
      [org.orgId, item.id],
    );
    expect(rows[0]?.data.paths).toEqual([spec.repoPath]);
  });
});

describe("repo → hub", () => {
  /** Hạng mục ghi thẳng nhánh mặc định của cả ba repo, đã đọc một lần để hub biết nội dung đang có. */
  async function syncedDirect() {
    const made = await newItem();
    await setRepoSync(made.item.id, "direct");
    await baseline(made.spec.docKey, "# Spec\n\nNội dung.\n");
    await baseline(made.contract.docKey, "openapi: 3.1.0\n");
    for (const k of ["a", "b", "c"] as const) {
      await syncItemProject(deps(), { orgId: org.orgId, itemId: made.item.id, projectId: p[k] });
      expect(await pullProject(deps(), { orgId: org.orgId, projectId: p[k] })).toMatchObject({ proposals: 0 });
    }
    return made;
  }

  it("PR chưa merge thì bỏ qua; merge xong nội dung bằng baseline thì không đề xuất", async () => {
    const { item, spec } = await newItem();
    await baseline(spec.docKey, "# Spec\n");
    await syncItemProject(deps(), { orgId: org.orgId, itemId: item.id, projectId: p.a });
    expect(await pullProject(deps(), { orgId: org.orgId, projectId: p.a })).toEqual({ checked: 1, proposals: 0 });
    await pushToMain("a", { [spec.repoPath]: "# Spec\n" });
    expect(await pullProject(deps(), { orgId: org.orgId, projectId: p.a })).toEqual({ checked: 1, proposals: 0 });
    expect(await proposals()).toEqual([]);
    expect((await syncRows(item.id, p.a))[0]).toMatchObject({ state: "synced" });
  });

  it("push sửa một dòng thành đề xuất đi lại cổng, không thành baseline; đọc lại không đề xuất lần hai", async () => {
    const { item, spec } = await syncedDirect();
    const { sha } = await pushToMain("a", { [spec.repoPath]: "# Spec\n\nNội dung đã sửa.\n" });
    const t0 = performance.now();
    expect(await pullProject(deps(), { orgId: org.orgId, projectId: p.a })).toEqual({ checked: 2, proposals: 1 });
    const pullMs = performance.now() - t0;
    expect(await proposals()).toEqual([
      {
        target: spec.docKey,
        content: "# Spec\n\nNội dung đã sửa.\n",
        reason: `Sửa trong repo ${key("a")}: ${sha.slice(0, 7)}`,
        author: org.user("admin"),
      },
    ]);
    const rows = await syncRows(item.id, p.a);
    expect(rows.find((r) => r.path === spec.repoPath)).toMatchObject({ state: "drifted", version: 1 });
    const { rows: art } = await admin.query("select baseline_version from hive.sdlc_artifacts where doc_key = $1", [
      spec.docKey,
    ]);
    expect(art[0]?.baseline_version).toBe(1);
    expect(await pullProject(deps(), { orgId: org.orgId, projectId: p.a })).toEqual({ checked: 2, proposals: 0 });
    // SC-004: sau webhook ≤ 5 phút, không webhook ≤ 20 phút (job gộp push 30 s, cron 15 phút).
    expect(PULL_DEBOUNCE_MS + pullMs).toBeLessThan(5 * 60_000);
    expect(SDLC_PULL_CRON).toBe("*/15 * * * *");
    expect(15 * 60_000 + pullMs).toBeLessThan(20 * 60_000);
  });

  it("sửa bản sao contract ở repo bên dùng thành đề xuất trên contract nguồn", async () => {
    const { contract, copyPath } = await syncedDirect();
    const { sha } = await pushToMain("b", {
      [copyPath]: `${copyHeader("openapi", key("a"))}\nopenapi: 3.1.1\n`,
    });
    expect(await pullProject(deps(), { orgId: org.orgId, projectId: p.b })).toEqual({ checked: 1, proposals: 1 });
    expect(await proposals()).toEqual([
      expect.objectContaining({
        target: contract.docKey,
        content: "openapi: 3.1.1\n",
        reason: `Sửa trong repo ${key("b")} (bản sao contract): ${sha.slice(0, 7)}`,
      }),
    ]);
  });

  it("file bị xoá trong repo thì đánh dấu deleted, có audit; ghi lại đúng nội dung thì về synced", async () => {
    const { item, copyPath } = await syncedDirect();
    await pushToMain("c", { [copyPath]: null });
    await pullProject(deps(), { orgId: org.orgId, projectId: p.c });
    expect(await syncRows(item.id, p.c)).toEqual([expect.objectContaining({ path: copyPath, state: "deleted" })]);
    const { rows } = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'sdlc.sync.drift' and target_id = $2",
      [org.orgId, item.id],
    );
    expect(rows.map((r) => r.data)).toEqual([expect.objectContaining({ path: copyPath, deleted: true })]);
    expect(await proposals()).toEqual([]);

    await pushToMain("c", { [copyPath]: `${copyHeader("openapi", key("a"))}\nopenapi: 3.1.0\n` });
    await pullProject(deps(), { orgId: org.orgId, projectId: p.c });
    expect((await syncRows(item.id, p.c))[0]).toMatchObject({ state: "synced" });
  });

  it("webhook push vào nhánh mặc định xếp job đọc sau 30 s; nhánh khác thì không", async () => {
    await newItem();
    const push = (branch: string) =>
      as("admin", (tx) =>
        onSdlcPush(
          {
            kind: "push",
            provider: "gitlab",
            repo: `xdev-team/repo-${key("a")}`,
            actor: "dev",
            actorId: 1,
            branch,
            sha: "f".repeat(40),
          },
          { tx, orgId: org.orgId, projectId: p.a } as unknown as ScmEventContext,
          jobs,
        ),
      );
    await push("feature/x");
    expect(queued).toEqual([]);
    await push("main");
    expect(queued).toEqual([
      expect.objectContaining({ queue: SDLC_PULL_QUEUE, data: { orgId: org.orgId, projectId: p.a } }),
    ]);
    const wait = (queued[0]?.opts?.startAfter?.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(PULL_DEBOUNCE_MS - 5_000);
    expect(queued[0]?.opts?.singletonKey).toBe(p.a);
  });

  it("cron quét dự án không có webhook; dự án có webhook chờ push", async () => {
    const { spec } = await syncedDirect();
    await admin.query("update hive.projects set webhook_secret_enc = 'x' where id = $1", [p.c]);
    queued = [];
    await scanProjects(deps());
    const mine = queued.filter((q) => q.queue === SDLC_PULL_QUEUE && q.data.orgId === org.orgId);
    expect(mine.map((q) => q.data.projectId).sort()).toEqual([p.a, p.b].sort());

    await pushToMain("a", { [spec.repoPath]: "# Spec\n\nSửa không qua webhook.\n" });
    for (const q of mine) await pullProject(deps(), q.data as { orgId: string; projectId: string });
    expect((await proposals()).map((x) => x.target)).toEqual([spec.docKey]);
  });
});

describe("SC-004", () => {
  it("baseline vào repo trong ≤ 2 phút khi provider sẵn sàng (gộp 10 s cộng thời gian job)", async () => {
    const { item, spec, contract } = await newItem();
    await baseline(spec.docKey, "# Spec\n");
    await baseline(contract.docKey, "openapi: 3.1.0\n");
    const t0 = performance.now();
    for (const k of ["a", "b", "c"] as const)
      await syncItemProject(deps(), { orgId: org.orgId, itemId: item.id, projectId: p[k] });
    expect(SYNC_DEBOUNCE_MS + (performance.now() - t0)).toBeLessThan(2 * 60_000);
  });
});

describe("nhận thư mục có sẵn (items.import)", () => {
  const folder = "specs/009-hoan-tien";
  const written = "# Đặc tả tính năng: Hoàn tiền một phần\n\nKhách được hoàn một phần tiền đơn hàng.\n";
  const importAs = (who: string, path = folder, d: SyncDeps = deps()) =>
    as(who, (tx) => importItem(tx, org.user(who), { projectId: p.a, path, modeRef: "speckit", size: "M" }, d));

  it("số và slug theo tên thư mục, file thành bản nháp đầu, không có baseline và không chạy bước tự động", async () => {
    await pushToMain("a", { [`${folder}/spec.md`]: written, [`${folder}/ghi-chu.txt`]: "ngoài khuôn" });
    queued = [];
    const item = await importAs("tmember", `${folder}/`);
    expect(item).toMatchObject({
      number: 9,
      slug: "hoan-tien",
      title: "Hoàn tiền một phần",
      source: { kind: "repo", path: folder },
    });
    expect(item.idea).toContain("Nhập từ repo");
    const spec = item.artifacts.find((a) => a.artifactId === "spec");
    expect(spec?.repoPath).toBe(`${folder}/spec.md`);
    const { rows } = await admin.query("select key, content from hive.doc_drafts where org_id = $1", [org.orgId]);
    expect(rows.find((r) => r.key === spec?.docKey)?.content).toBe(written);
    const { rows: base } = await admin.query(
      "select count(*)::int as n from hive.sdlc_artifacts where item_id = $1 and baseline_version is not null",
      [item.id],
    );
    expect(base[0].n).toBe(0);
    expect(queued).toEqual([]);
    const { rows: audit } = await admin.query(
      "select data from hive.audit_log where org_id = $1 and target_id = $2 and action = 'sdlc.item.create'",
      [org.orgId, item.id],
    );
    expect(audit[0]?.data).toMatchObject({ path: folder, importedPaths: [`${folder}/spec.md`] });
  });

  it("từ chối tên thư mục sai mẫu, thư mục rỗng, số đã có, không có quyền hay hub không có Git", async () => {
    await pushToMain("a", { [`${folder}/spec.md`]: written, "docs/hoan-tien/spec.md": written });
    expect(await errorCode(() => importAs("tmember", "docs/hoan-tien"))).toBe("SDLC_IMPORT_PATH");
    expect(await errorCode(() => importAs("tmember", "specs/010-chua-co"))).toBe("SDLC_IMPORT_EMPTY");
    expect(await errorCode(() => importAs("tviewer"))).toBe("SDLC_FORBIDDEN");
    expect(await errorCode(() => importAs("tmember", folder, { pool: app, jobs }))).toBe("SDLC_IMPORT_NO_GIT");
    await importAs("tmember");
    expect(await errorCode(() => importAs("tmember"))).toBe("SDLC_IMPORT_TAKEN");
  });

  it("thư mục không khớp mẫu đường dẫn của chế độ thì từ chối", async () => {
    await pushToMain("a", { "docs/009-hoan-tien/spec.md": written });
    expect(await errorCode(() => importAs("tmember", "docs/009-hoan-tien"))).toBe("SDLC_IMPORT_LAYOUT");
  });

  it("hạng mục mới sau khi nhận lấy số kế tiếp", async () => {
    await pushToMain("a", { [`${folder}/spec.md`]: written });
    await importAs("tmember");
    const next = await newItem();
    expect(next.item.number).toBe(10);
  });
});
