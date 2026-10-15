import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { getDoc, type Principal, saveDoc } from "../knowledge/index.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import {
  type CommitChange,
  createMemoryProvider,
  type GitProvider,
  GitProviderError,
  type MemoryProvider,
  type PushEvent,
  type ScmEventContext,
} from "../scm/index.ts";
import { contentHash } from "./content.ts";
import { configureOrgHome, configureProjectHome, type HomeRow } from "./homes.ts";
import { onDocsPush, pullHome, scanHomes } from "./pull.ts";
import { DOCSYNC_PULL_QUEUE, DOCSYNC_PUSH_QUEUE } from "./queues.ts";
import { docConflicts, docHomes, docRepoFiles } from "./schema.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const pool = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const queued: Array<{ queue: string; data: { orgId?: string; homeId?: string } }> = [];
const jobs = {
  enqueue: async (queue: string, data: { orgId?: string; homeId?: string }) => {
    queued.push({ queue, data });
    return randomUUID();
  },
} as unknown as Jobs;

type Kind = "github" | "gitlab";
type Fixture = Awaited<ReturnType<typeof setup>>;
const fixtures = {} as Record<Kind, Fixture>;
const user = (f: Fixture, who = "admin"): Principal => ({ kind: "user", userId: f.org.user(who) });
const as = <T>(f: Fixture, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pool, { orgId: f.org.orgId, userId: f.org.user("admin") }, fn);
const doc = "# Hướng dẫn\n\nĐoạn một.\n\nĐoạn hai.\n\nĐoạn ba.\n";

async function setup(kind: Kind) {
  const org = await seedOrg(admin, `pull-${kind}-${tag}`);
  const key = `pl${kind.slice(0, 2)}${tag}`;
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key,
  });
  const provider = createMemoryProvider(kind, [project.owner]);
  // Bọc provider để từng test đổi `compare` (giả `renamed` từ API) mà không đụng repo trong bộ nhớ.
  let compare: GitProvider["compare"] | null = null;
  const wrapped: GitProvider = new Proxy(provider, {
    get: (target, prop, receiver) => (prop === "compare" && compare ? compare : Reflect.get(target, prop, receiver)),
  });
  const deps = { pool, jobs, masterKey, providerFactory: () => wrapped };
  const orgRef = { owner: project.owner, name: `docs-${tag}` };
  const projectRef = { owner: project.owner, name: project.repo };
  provider.seedRepo(orgRef, { files: { "README.md": "# Tài liệu\n" } });
  provider.seedRepo(projectRef, { files: { "README.md": "# Dự án\n" } });
  const actor = { orgId: org.orgId, userId: org.user("admin") };
  const home = await withTenant(pool, actor, (tx) =>
    configureOrgHome(tx, deps, actor, {
      connectionId: project.connectionId,
      owner: orgRef.owner,
      name: orgRef.name,
      root: "",
      include: [],
    }),
  );
  const projectHome = await withTenant(pool, actor, (tx) =>
    configureProjectHome(tx, deps, actor, {
      project: key,
      settings: {
        enabled: true,
        root: "docs/",
        repoSync: "pr",
        include: ["docs/**"],
        exclude: [],
        assetsDir: "assets",
        repoChangesNeedReview: true,
      },
    }),
  );
  return {
    kind,
    org,
    project: { ...project, key },
    provider,
    deps,
    home,
    projectHome,
    orgRef,
    projectRef,
    setCompare: (fn: GitProvider["compare"] | null) => {
      compare = fn;
    },
  };
}

const pull = (f: Fixture, home: HomeRow = f.home) => pullHome(f.deps, { orgId: f.org.orgId, homeId: home.id });
const refOf = (f: Fixture, home: HomeRow) => (home.id === f.home.id ? f.orgRef : f.projectRef);

async function commit(
  f: Fixture,
  files: Array<
    { path: string; content: string } | { path: string; delete: true } | { path: string; previousPath: string }
  >,
  home: HomeRow = f.home,
): Promise<string> {
  await f.provider.commitFiles(refOf(f, home), { branch: "main", message: "Sửa tài liệu", files });
  return (await f.provider.branchHead(refOf(f, home), "main")) as string;
}

/** Tài liệu đã đồng bộ: phiên bản 1 trên hub, cùng nội dung trong repo, `last_commit` ở commit đó. */
async function tracked(f: Fixture, opts: { key?: string; path?: string; content?: string; home?: HomeRow } = {}) {
  const home = opts.home ?? f.home;
  const slug = `f-${randomUUID().slice(0, 8)}`;
  const key = opts.key ?? (home.id === f.home.id ? `team/thanh-toan/${slug}` : `project/${f.project.key}/${slug}`);
  const path = opts.path ?? (home.id === f.home.id ? `teams/thanh-toan/${slug}.md` : `docs/${slug}.md`);
  const content = opts.content ?? doc;
  const saved = await as(f, (tx) => saveDoc(tx, user(f), { key, content, baseVersion: 0 }));
  await as(f, (tx) =>
    tx.insert(docRepoFiles).values({
      orgId: f.org.orgId,
      homeId: home.id,
      docId: saved.id,
      repoPath: path,
      state: "synced",
      syncedVersion: 1,
      syncedHash: contentHash(content),
      repoHash: contentHash(content),
    }),
  );
  await commit(f, [{ path, content }], home);
  // Lần kéo này chỉ đưa `last_commit` tới head: file đã có cùng hash nên không tạo phiên bản.
  expect((await pull(f, home)).counts.failed).toBeUndefined();
  return { key, path, docId: saved.id, content };
}

const fileOf = (f: Fixture, docId: string) =>
  as(f, async (tx) => (await tx.select().from(docRepoFiles).where(eq(docRepoFiles.docId, docId)))[0]);
const hubDoc = (f: Fixture, key: string) => as(f, (tx) => getDoc(tx, user(f), { key }));
const homeRow = (f: Fixture, id: string) =>
  as(f, async (tx) => (await tx.select().from(docHomes).where(eq(docHomes.id, id)))[0]);
const openConflicts = (f: Fixture, docId: string) =>
  as(f, (tx) => tx.select().from(docConflicts).where(eq(docConflicts.docId, docId)));
async function version(docId: string, v: number) {
  return (await admin.query("select * from hive.doc_versions where doc_id = $1 and version = $2", [docId, v])).rows[0];
}
async function inbox(f: Fixture, event: string) {
  return (
    await admin.query("select user_id, title, body from hive.inbox_items where org_id = $1 and event = $2", [
      f.org.orgId,
      event,
    ])
  ).rows;
}
async function setHome(f: Fixture, home: HomeRow, values: Partial<HomeRow>) {
  await as(f, (tx) => tx.update(docHomes).set(values).where(eq(docHomes.id, home.id)));
}

beforeAll(async () => {
  for (const kind of ["github", "gitlab"] as const) fixtures[kind] = await setup(kind);
});
afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe.each(["github", "gitlab"] as const)("%s: repo → hub", (kind) => {
  const f = () => fixtures[kind];

  it("hub không đổi: phiên bản mới nguồn repo, ghi commit; kéo lại không làm gì (US3 kịch bản 1)", async () => {
    const item = await tracked(f());
    const changed = doc.replace("Đoạn hai.", "Đoạn hai, sửa trong repo.");
    const head = await commit(f(), [{ path: item.path, content: changed }]);
    const result = await pull(f());
    expect(result).toMatchObject({ head, status: "synced", counts: { applied: 1 } });
    expect(await hubDoc(f(), item.key)).toMatchObject({ version: 2, content: changed });
    expect(await version(item.docId, 2)).toMatchObject({ source: "repo", repo_commit: head });
    expect((await version(item.docId, 2)).message).toContain(head.slice(0, 12));
    expect(await fileOf(f(), item.docId)).toMatchObject({
      state: "synced",
      syncedVersion: 2,
      syncedCommit: head,
      syncedHash: contentHash(changed),
      repoHash: contentHash(changed),
    });
    expect((await homeRow(f(), f().home.id))?.lastCommit).toBe(head);
    expect(await pull(f())).toMatchObject({ status: "unchanged" });
  });

  it("CRLF và BOM: hub lưu LF, hash theo byte repo", async () => {
    const item = await tracked(f());
    const raw = `﻿${doc.replace("Đoạn ba.", "Đoạn ba mới.").replace(/\n/g, "\r\n")}`;
    await commit(f(), [{ path: item.path, content: raw }]);
    await pull(f());
    expect((await hubDoc(f(), item.key)).content).toBe(doc.replace("Đoạn ba.", "Đoạn ba mới."));
    expect(await fileOf(f(), item.docId)).toMatchObject({ eol: "crlf", bom: true, repoHash: contentHash(raw) });
  });

  it("hub và repo đổi khác khối: hợp bằng mergeBlocks và xếp lô đẩy (US3 kịch bản 2)", async () => {
    const item = await tracked(f());
    const hub = doc.replace("Đoạn một.", "Đoạn một, sửa trên hub.");
    await as(f(), (tx) => saveDoc(tx, user(f()), { key: item.key, content: hub, baseVersion: 1 }));
    const repo = doc.replace("Đoạn ba.", "Đoạn ba, sửa trong repo.");
    queued.length = 0;
    const head = await commit(f(), [{ path: item.path, content: repo }]);
    expect((await pull(f())).counts).toMatchObject({ merged: 1 });
    const merged = await hubDoc(f(), item.key);
    expect(merged.version).toBe(3);
    expect(merged.content).toContain("Đoạn một, sửa trên hub.");
    expect(merged.content).toContain("Đoạn ba, sửa trong repo.");
    expect(await version(item.docId, 3)).toMatchObject({ source: "merge", repo_commit: head });
    expect(await fileOf(f(), item.docId)).toMatchObject({ state: "pending", syncedHash: contentHash(repo) });
    expect(queued).toContainEqual({ queue: DOCSYNC_PUSH_QUEUE, data: { orgId: f().org.orgId, homeId: f().home.id } });
  });

  it("cùng khối: tạo xung đột và báo quản trị; repo đổi tiếp thì cập nhật xung đột cũ (US3 kịch bản 3, 4)", async () => {
    const item = await tracked(f());
    await as(f(), (tx) =>
      saveDoc(tx, user(f()), { key: item.key, content: doc.replace("Đoạn hai.", "Hub viết."), baseVersion: 1 }),
    );
    const first = await commit(f(), [{ path: item.path, content: doc.replace("Đoạn hai.", "Repo viết.") }]);
    expect((await pull(f())).counts).toMatchObject({ conflict: 1 });
    expect((await hubDoc(f(), item.key)).version).toBe(2);
    expect(await fileOf(f(), item.docId)).toMatchObject({ state: "conflict", syncedVersion: 1 });
    const [conflict] = await openConflicts(f(), item.docId);
    expect(conflict).toMatchObject({
      state: "open",
      baseVersion: 1,
      hubVersion: 2,
      repoCommit: first,
      repoContent: doc.replace("Đoạn hai.", "Repo viết."),
    });
    const notices = await inbox(f(), "docsync.conflict");
    expect(notices.some((n) => n.user_id === f().org.user("admin") && n.body.includes(item.key))).toBe(true);

    const second = await commit(f(), [{ path: item.path, content: doc.replace("Đoạn hai.", "Repo viết lại.") }]);
    expect((await pull(f())).counts).toMatchObject({ conflict: 1 });
    const all = await openConflicts(f(), item.docId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: conflict?.id,
      repoCommit: second,
      repoContent: doc.replace("Đoạn hai.", "Repo viết lại."),
    });
    expect((await inbox(f(), "docsync.conflict")).filter((n) => n.body.includes(item.key))).toHaveLength(
      notices.filter((n) => n.body.includes(item.key)).length,
    );
  });

  it("commit do hub đẩy (hash trùng phiên bản hub): không tạo phiên bản lặp (US3 kịch bản 5)", async () => {
    const item = await tracked(f());
    const hub = doc.replace("Đoạn ba.", "Đoạn ba từ hub.");
    await as(f(), (tx) => saveDoc(tx, user(f()), { key: item.key, content: hub, baseVersion: 1 }));
    await as(f(), (tx) => tx.update(docRepoFiles).set({ state: "pending" }).where(eq(docRepoFiles.docId, item.docId)));
    const head = await commit(f(), [{ path: item.path, content: hub }]);
    expect((await pull(f())).counts).toMatchObject({ skipped: 1 });
    expect((await hubDoc(f(), item.key)).version).toBe(2);
    expect(await fileOf(f(), item.docId)).toMatchObject({
      state: "synced",
      syncedVersion: 2,
      syncedCommit: head,
      repoHash: contentHash(hub),
    });
  });

  it("file bị xoá: chuyển deleted_in_repo, giữ tài liệu và báo (US3 kịch bản 6)", async () => {
    const item = await tracked(f());
    await commit(f(), [{ path: item.path, delete: true }]);
    expect((await pull(f())).counts).toMatchObject({ deleted: 1 });
    expect(await fileOf(f(), item.docId)).toMatchObject({ state: "deleted_in_repo" });
    expect((await hubDoc(f(), item.key)).version).toBe(1);
    expect((await inbox(f(), "docsync.deleted_in_repo")).some((n) => n.body.includes(item.path))).toBe(true);
  });

  it("file markdown mới khớp nhà: tạo tài liệu nguồn repo, key trùng thì thêm hậu tố (US3 kịch bản 7)", async () => {
    const slug = `moi-${randomUUID().slice(0, 6)}`;
    const taken = await as(f(), (tx) =>
      saveDoc(tx, user(f()), { key: `org/${slug}`, content: "# Có sẵn\n", baseVersion: 0 }),
    );
    const head = await commit(f(), [
      { path: `teams/thanh-toan/${slug}.md`, content: "# Tài liệu mới\n\nNội dung.\n" },
      { path: `org/${slug}.md`, content: "# Tài liệu tổ chức\n" },
      { path: "ghi-chu.txt", content: "không phải markdown" },
    ]);
    expect((await pull(f())).counts).toMatchObject({ created: 2 });
    const team = await hubDoc(f(), `team/thanh-toan/${slug}`);
    expect(team).toMatchObject({ version: 1, title: "Tài liệu mới", scope: { teamId: f().org.teamId } });
    expect(await version(team.id, 1)).toMatchObject({ source: "repo", repo_commit: head });
    expect(await fileOf(f(), team.id)).toMatchObject({
      repoPath: `teams/thanh-toan/${slug}.md`,
      state: "synced",
      syncedVersion: 1,
    });
    const second = await hubDoc(f(), `org/${slug}-2`);
    expect(second.content).toBe("# Tài liệu tổ chức\n");
    expect((await hubDoc(f(), `org/${slug}`)).id).toBe(taken.id);
  });

  it("đổi tên theo hash: giữ tài liệu, chỉ đổi đường dẫn", async () => {
    const item = await tracked(f());
    const to = item.path.replace(".md", "-moi.md");
    await commit(f(), [{ path: to, previousPath: item.path }]);
    expect((await pull(f())).counts).toMatchObject({ renamed: 1 });
    expect(await fileOf(f(), item.docId)).toMatchObject({ repoPath: to, state: "synced" });
    expect((await hubDoc(f(), item.key)).version).toBe(1);
  });

  it("đổi tên và sửa ít: ghép theo độ giống khối, nội dung mới thành phiên bản repo", async () => {
    // Ngưỡng ghép là 80% khối giống nhau nên cần tài liệu đủ dài để sửa một khối vẫn qua.
    const long = `# Quy trình\n\n${Array.from({ length: 9 }, (_, i) => `Bước ${i + 1}.`).join("\n\n")}\n`;
    const item = await tracked(f(), { content: long });
    const to = item.path.replace(".md", "-sua.md");
    const content = long.replace("Bước 3.", "Bước 3, sửa nhẹ.");
    await commit(f(), [
      { path: item.path, delete: true },
      { path: to, content },
    ]);
    expect((await pull(f())).counts).toMatchObject({ renamed: 1, applied: 1 });
    expect(await fileOf(f(), item.docId)).toMatchObject({ repoPath: to });
    expect(await hubDoc(f(), item.key)).toMatchObject({ version: 2, content });
  });

  it("đổi tên do API báo (renamed): giữ tài liệu dù nội dung viết lại hết", async () => {
    const item = await tracked(f());
    const to = item.path.replace(".md", "-api.md");
    const content = "# Viết lại\n\nKhác hẳn bản cũ.\n";
    const head = await commit(f(), [
      { path: item.path, delete: true },
      { path: to, content },
    ]);
    f().setCompare(async () => ({
      files: [{ path: to, previousPath: item.path, status: "renamed", sha: content } satisfies CommitChange],
      incomplete: false,
    }));
    try {
      expect(await pull(f())).toMatchObject({ head, counts: { renamed: 1, applied: 1 } });
    } finally {
      f().setCompare(null);
    }
    expect(await fileOf(f(), item.docId)).toMatchObject({ repoPath: to, state: "synced" });
    expect(await hubDoc(f(), item.key)).toMatchObject({ version: 2, content });
  });

  it("compare báo thiếu: so cây ở head", async () => {
    const item = await tracked(f());
    const content = doc.replace("Đoạn một.", "Đoạn một qua so cây.");
    await commit(f(), [{ path: item.path, content }]);
    f().setCompare(async () => ({ files: [], incomplete: true }));
    try {
      expect((await pull(f())).counts).toMatchObject({ applied: 1 });
    } finally {
      f().setCompare(null);
    }
    expect((await hubDoc(f(), item.key)).content).toBe(content);
    expect(f().provider.calls.some((c) => c.method === "listFiles")).toBe(true);
  });

  it("nội dung có bí mật: phiên bản đánh dấu, file chuyển blocked_secret", async () => {
    const item = await tracked(f());
    await commit(f(), [{ path: item.path, content: `${doc}\nKhoá: AKIA${"Q".repeat(16)}\n` }]);
    await pull(f());
    expect(await version(item.docId, 2)).toMatchObject({ source: "repo", secret_flag: true });
    expect(await fileOf(f(), item.docId)).toMatchObject({ state: "blocked_secret" });
  });
});

describe("nhà dự án", () => {
  const f = () => fixtures.gitlab;

  it("push vào nhánh của nhà xếp job kéo; nhánh khác bỏ qua", async () => {
    queued.length = 0;
    const event = (branch: string) => ({ kind: "push", branch, sha: "c".repeat(40) }) as PushEvent;
    await as(f(), async (tx) => {
      const ctx = { tx, orgId: f().org.orgId, projectId: f().project.projectId } as ScmEventContext;
      await onDocsPush(event("feature/x"), ctx, jobs);
      await onDocsPush(event("main"), ctx, jobs);
    });
    expect(queued).toEqual([{ queue: DOCSYNC_PULL_QUEUE, data: { orgId: f().org.orgId, homeId: f().projectHome.id } }]);
  });

  it("cron quét mọi nhà đang chạy", async () => {
    queued.length = 0;
    expect(await scanHomes({ pool, jobs })).toBeGreaterThanOrEqual(4);
    for (const fx of Object.values(fixtures))
      for (const home of [fx.home, fx.projectHome])
        expect(queued).toContainEqual({ queue: DOCSYNC_PULL_QUEUE, data: { orgId: fx.org.orgId, homeId: home.id } });
  });

  it("repoChangesNeedReview: tạo đề xuất thay vì lưu thẳng", async () => {
    const item = await tracked(f(), { home: f().projectHome });
    const content = doc.replace("Đoạn hai.", "Đoạn hai cần duyệt.");
    await commit(f(), [{ path: item.path, content }], f().projectHome);
    expect((await pull(f(), f().projectHome)).counts).toMatchObject({ proposed: 1 });
    expect((await hubDoc(f(), item.key)).version).toBe(1);
    const { rows } = await admin.query(
      "select kind, target, content, base_version, author_user_id from hive.proposals where target = $1",
      [item.key],
    );
    expect(rows).toEqual([
      { kind: "doc", target: item.key, content, base_version: 1, author_user_id: f().org.user("admin") },
    ]);
    expect(await fileOf(f(), item.docId)).toMatchObject({ syncedVersion: 1, repoHash: contentHash(content) });
  });

  it("file mới trong nhà dự án: key và phạm vi theo dự án", async () => {
    const slug = `moi-${randomUUID().slice(0, 6)}`;
    await commit(
      f(),
      [
        { path: `docs/${slug}.md`, content: "# Dự án mới\n" },
        { path: `src/${slug}.md`, content: "# Không thuộc nhà\n" },
      ],
      f().projectHome,
    );
    expect((await pull(f(), f().projectHome)).counts).toMatchObject({ created: 1 });
    expect(await hubDoc(f(), `project/${f().project.key}/${slug}`)).toMatchObject({
      scope: { teamId: f().org.teamId, projectId: f().project.projectId },
    });
  });

  it("nhánh mặc định đổi: tạm dừng, báo một lần, không kéo", async () => {
    const repo = (f().provider as MemoryProvider).repos.get(
      `${f().projectRef.owner}/${f().projectRef.name}`.toLowerCase(),
    );
    if (!repo) throw new Error("Thiếu repo dự án.");
    repo.info.defaultBranch = "develop";
    try {
      expect(await pull(f(), f().projectHome)).toMatchObject({ status: "paused" });
      expect(await homeRow(f(), f().projectHome.id)).toMatchObject({
        status: "paused",
        statusReason: "default_branch_changed",
      });
      const notices = await inbox(f(), "docsync.paused");
      expect(notices.length).toBeGreaterThan(0);
      expect(notices.every((n) => n.body.includes("develop"))).toBe(true);
      expect(await pull(f(), f().projectHome)).toMatchObject({ status: "inactive" });
      expect(await inbox(f(), "docsync.paused")).toHaveLength(notices.length);
    } finally {
      repo.info.defaultBranch = "main";
      await setHome(f(), f().projectHome, { status: "active", statusReason: null, error: null });
    }
  });

  it("mất quyền repo: nhà chuyển lỗi quyền", async () => {
    f().provider.fail("getRepo", new GitProviderError("forbidden", "gitlab: 403", { status: 403 }));
    try {
      expect(await pull(f(), f().projectHome)).toMatchObject({ status: "error" });
      expect(await homeRow(f(), f().projectHome.id)).toMatchObject({ status: "error", statusReason: "no_access" });
      expect(await inbox(f(), "docsync.sync_failed")).not.toHaveLength(0);
    } finally {
      f().provider.fail("getRepo", null);
      await setHome(f(), f().projectHome, { status: "active", statusReason: null, error: null });
    }
  });
});
