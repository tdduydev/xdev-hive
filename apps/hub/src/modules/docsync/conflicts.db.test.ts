import { randomBytes, randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { docConflictDetail, scanSecrets } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import type { Auth } from "../identity/index.ts";
import { getDoc, listDocs, type Principal, saveDoc } from "../knowledge/index.ts";
import { createJobs, createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider } from "../scm/index.ts";
import { ConflictSecretError, getConflict, listConflicts, resolveConflict } from "./conflicts.ts";
import { contentHash, fromLf } from "./content.ts";
import { configureOrgHome } from "./homes.ts";
import { DOCSYNC_PUSH_QUEUE, docSyncQueues, queuePush } from "./jobs.ts";
import { conflictsRoutes } from "./routes/conflicts.ts";
import { docConflicts, docRepoFiles } from "./schema.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const pool = createPool(db.appUrl);
const jobs = createJobs({ connectionString: db.jobsUrl, queues: docSyncQueues, maintenance: false });
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const baseContent = "# Hướng dẫn\n\nNội dung gốc.\n";
const hubContent = "# Hướng dẫn\n\nNội dung trên hub.\n";
const repoContent = "# Hướng dẫn\n\nNội dung từ repo.\n";
const repoCommit = "b".repeat(40);
const secret = `AKIA${"Q".repeat(16)}`;
const secretContent = `# Cấu hình\n\nKhoá truy cập: ${secret}\n`;
type Fixture = Awaited<ReturnType<typeof setup>>;
const fixtures = {} as Record<"github" | "gitlab", Fixture>;
const user = (f: Fixture, who = "tadmin"): Principal => ({ kind: "user", userId: f.org.user(who) });
const as = <T>(f: Fixture, who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pool, { orgId: f.org.orgId, userId: f.org.user(who) }, fn);
const enqueue = (tx: Tx, home: { orgId: string; homeId: string }) => queuePush(jobs, home, { tx });

async function setup(kind: "github" | "gitlab") {
  const org = await seedOrg(admin, `conflict-${kind}-${tag}`);
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `cf-${kind}-${tag}`,
  });
  const provider = createMemoryProvider(kind, [project.owner]);
  provider.seedRepo({ owner: project.owner, name: `docs-${tag}` }, { files: { "README.md": "# Tài liệu\n" } });
  const home = await withTenant(pool, { orgId: org.orgId, userId: org.user("admin") }, (tx) =>
    configureOrgHome(
      tx,
      { masterKey, providerFactory: () => provider },
      { orgId: org.orgId, userId: org.user("admin") },
      {
        connectionId: project.connectionId,
        owner: project.owner,
        name: `docs-${tag}`,
      },
    ),
  );
  return { org, project, provider, home };
}

async function seedConflict(
  f: Fixture,
  opts: {
    scope?: "team" | "org" | "other";
    deleted?: boolean;
    content?: string;
    eol?: "lf" | "crlf";
    bom?: boolean;
  } = {},
) {
  const prefix = opts.scope === "org" ? "org" : opts.scope === "other" ? "team/crm" : "team/thanh-toan";
  const key = `${prefix}/conflict-${randomUUID()}`;
  return as(f, "admin", async (tx) => {
    const base = await saveDoc(tx, user(f, "admin"), { key, content: baseContent, baseVersion: 0 });
    const hub = await saveDoc(tx, user(f, "admin"), { key, content: hubContent, baseVersion: 1 });
    const [file] = await tx
      .insert(docRepoFiles)
      .values({
        orgId: f.org.orgId,
        homeId: f.home.id,
        docId: hub.id,
        repoPath: `${prefix === "org" ? "org" : "teams/thanh-toan"}/${hub.id}.md`,
        state: opts.deleted ? "deleted_in_repo" : "conflict",
        syncedVersion: 1,
        syncedHash: contentHash(baseContent),
        syncedCommit: "a".repeat(40),
        repoHash: opts.deleted ? null : contentHash(opts.content ?? repoContent),
        eol: opts.eol ?? "lf",
        bom: opts.bom ?? false,
        error: "Lỗi cũ.",
      })
      .returning();
    const [conflict] = opts.deleted
      ? []
      : await tx
          .insert(docConflicts)
          .values({
            orgId: f.org.orgId,
            homeId: f.home.id,
            docId: hub.id,
            baseVersion: base.version,
            hubVersion: hub.version,
            repoCommit,
            repoContent: opts.content ?? repoContent,
          })
          .returning();
    if (!file) throw new Error("Thiếu file đồng bộ mẫu.");
    return { key, docId: hub.id, file, conflict: conflict ?? null };
  });
}

function conflictId(item: Awaited<ReturnType<typeof seedConflict>>): string {
  if (!item.conflict) throw new Error("Thiếu xung đột mẫu.");
  return item.conflict.id;
}

async function saved(f: Fixture, key: string) {
  return as(f, "admin", (tx) => getDoc(tx, user(f, "admin"), { key }));
}
async function state(f: Fixture, docId: string) {
  return as(f, "admin", async (tx) => (await tx.select().from(docRepoFiles).where(eq(docRepoFiles.docId, docId)))[0]);
}
async function versionRow(docId: string, version: number) {
  return (await admin.query("select * from hive.doc_versions where doc_id = $1 and version = $2", [docId, version]))
    .rows[0];
}

beforeAll(async () => {
  await jobs.start();
  for (const kind of ["github", "gitlab"] as const) fixtures[kind] = await setup(kind);
});
afterAll(async () => {
  await jobs.stop();
  await Promise.all([admin.end(), pool.end()]);
});

describe("giải quyết xung đột trên PostgreSQL thật", () => {
  it.each(["github", "gitlab"] as const)(
    "%s: trả ba bản, giữ bản hub, audit và xếp job chung transaction",
    async (kind) => {
      const f = fixtures[kind];
      const item = await seedConflict(f);
      const detail = await as(f, "tadmin", (tx) => getConflict(tx, user(f), conflictId(item)));
      expect(docConflictDetail.parse(detail)).toMatchObject({
        baseContent,
        hubContent,
        repoContent,
        merge: { conflicts: 1 },
      });
      const calls = f.provider.calls.length;
      const result = await as(f, "tadmin", (tx) =>
        resolveConflict(tx, user(f), { id: detail.id, choice: "hub", baseVersion: 2 }, enqueue),
      );
      expect(result).toEqual({ key: item.key, version: 3 });
      expect((await saved(f, item.key)).content).toBe(hubContent);
      expect(await versionRow(item.docId, 3)).toMatchObject({ source: "merge", repo_commit: repoCommit });
      expect(await state(f, item.docId)).toMatchObject({
        state: "pending",
        syncedHash: contentHash(repoContent),
        repoHash: contentHash(repoContent),
        syncedCommit: repoCommit,
        error: null,
      });
      const resolved = await as(
        f,
        "admin",
        async (tx) => (await tx.select().from(docConflicts).where(eq(docConflicts.id, detail.id)))[0],
      );
      expect(resolved).toMatchObject({
        state: "resolved",
        resolution: "hub",
        resolvedBy: f.org.user("tadmin"),
        resolvedVersion: 3,
      });
      const audit = await admin.query(
        "select actor_user_id, data from hive.audit_log where target_id = $1 and action = 'doc.conflict_resolve'",
        [item.docId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ actor_user_id: f.org.user("tadmin"), data: { choice: "hub", version: 3 } });
      const pending = await admin.query(
        "select data from pgboss.job where name = $1 and singleton_key = $2 and state = 'created'",
        [DOCSYNC_PUSH_QUEUE, f.home.id],
      );
      expect(pending.rows).toHaveLength(1);
      expect(pending.rows[0].data).toEqual({ homeId: f.home.id, orgId: f.org.orgId });
      expect(f.provider.calls).toHaveLength(calls);
    },
  );

  it("giữ bản repo làm phiên bản merge, hash base giữ đúng CRLF và BOM", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f, { eol: "crlf", bom: true });
    await as(f, "tadmin", (tx) =>
      resolveConflict(tx, user(f), { id: conflictId(item), choice: "repo", baseVersion: 2 }, enqueue),
    );
    expect((await saved(f, item.key)).content).toBe(repoContent);
    expect(await state(f, item.docId)).toMatchObject({
      state: "pending",
      syncedHash: contentHash(fromLf(repoContent, "crlf", true)),
    });
  });

  it("đang xung đột vẫn sửa hub được; detail dùng bản mới nhất và từ chối base cũ", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f);
    await as(f, "tadmin", (tx) => saveDoc(tx, user(f), { key: item.key, content: "Bản hub mới hơn.", baseVersion: 2 }));
    expect(await as(f, "tadmin", (tx) => getConflict(tx, user(f), conflictId(item)))).toMatchObject({
      hubVersion: 3,
      hubContent: "Bản hub mới hơn.",
    });
    await expect(
      as(f, "tadmin", (tx) =>
        resolveConflict(tx, user(f), { id: conflictId(item), choice: "hub", baseVersion: 2 }, enqueue),
      ),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await as(f, "tadmin", (tx) =>
      resolveConflict(tx, user(f), { id: conflictId(item), choice: "hub", baseVersion: 3 }, enqueue),
    );
    expect(await saved(f, item.key)).toMatchObject({ content: "Bản hub mới hơn.", version: 4 });
  });

  it("sửa tay tạo phiên bản mới và hai người giải quyết chỉ một người ghi được", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f);
    const resolve = () =>
      as(f, "tadmin", (tx) =>
        resolveConflict(
          tx,
          user(f),
          { id: conflictId(item), choice: "manual", baseVersion: 2, content: "Bản hợp thủ công." },
          enqueue,
        ),
      );
    const results = await Promise.allSettled([resolve(), resolve()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "DOCSYNC_CONFLICT_RESOLVED" },
    });
    expect(await saved(f, item.key)).toMatchObject({ content: "Bản hợp thủ công.", version: 3 });
  });

  it("quyền manage áp dụng trước phân trang, lọc theo nhà và trạng thái", async () => {
    const f = fixtures.gitlab;
    const first = await seedConflict(f);
    const second = await seedConflict(f);
    await seedConflict(f, { scope: "org" });
    const other = await seedConflict(f, { scope: "other" });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await as(f, "tadmin", (tx) => listConflicts(tx, user(f), { homeId: f.home.id, limit: 1, cursor }));
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(expect.arrayContaining([conflictId(first), conflictId(second)]));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(conflictId(other));
    expect(await as(f, "tmember", (tx) => listConflicts(tx, user(f, "tmember"), {}))).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(await as(f, "tadmin", (tx) => listConflicts(tx, user(f), { homeId: randomUUID() }))).toEqual({
      items: [],
      nextCursor: null,
    });
    const resolved = await as(f, "tadmin", (tx) => listConflicts(tx, user(f), { state: "resolved" }));
    expect(resolved.items.length).toBeGreaterThan(0);
    expect(resolved.items.every((i) => i.state === "resolved")).toBe(true);
  });

  it("thành viên, đội khác, run và tenant khác không được xem hay giải quyết", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f);
    for (const who of ["tmember", "tviewer", "oadmin", "loner"]) {
      await expect(as(f, who, (tx) => getConflict(tx, user(f, who), conflictId(item)))).rejects.toMatchObject({
        code: "DOCSYNC_CONFLICT_NOT_FOUND",
      });
      await expect(
        as(f, who, (tx) =>
          resolveConflict(tx, user(f, who), { id: conflictId(item), choice: "hub", baseVersion: 2 }, enqueue),
        ),
      ).rejects.toBeInstanceOf(Error);
    }
    const run: Principal = { kind: "run", runId: randomUUID(), projectId: f.project.projectId };
    await expect(
      as(f, "tadmin", (tx) =>
        resolveConflict(tx, run, { id: conflictId(item), choice: "hub", baseVersion: 2 }, enqueue),
      ),
    ).rejects.toMatchObject({ code: "RUN_NOT_ALLOWED" });
    const other = fixtures.github;
    await expect(
      as(other, "admin", (tx) => getConflict(tx, user(other, "admin"), conflictId(item))),
    ).rejects.toMatchObject({ code: "DOCSYNC_CONFLICT_NOT_FOUND" });
    await expect(
      as(other, "admin", (tx) =>
        resolveConflict(tx, user(other, "admin"), { id: conflictId(item), choice: "hub", baseVersion: 2 }, enqueue),
      ),
    ).rejects.toMatchObject({ code: "DOCSYNC_CONFLICT_NOT_FOUND" });
    expect((await saved(f, item.key)).version).toBe(2);
  });

  it("sửa tay bị chặn bí mật; xác nhận gắn hash, chỉ audit loại và dòng", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f);
    const input = { id: conflictId(item), choice: "manual" as const, content: secretContent, baseVersion: 2 };
    const error = await as(f, "tadmin", (tx) => resolveConflict(tx, user(f), input, enqueue)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictSecretError);
    expect(error).toMatchObject({ findings: scanSecrets(secretContent) });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(await state(f, item.docId)).toMatchObject({ state: "conflict" });
    expect((await saved(f, item.key)).version).toBe(2);
    await as(f, "tadmin", (tx) => resolveConflict(tx, user(f), { ...input, acknowledgeSecrets: true }, enqueue));
    expect(await versionRow(item.docId, 3)).toMatchObject({ secret_flag: false, source: "merge" });
    const audit = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'doc.secrets.acknowledge' and target_id = $2",
      [f.org.orgId, item.key],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].data).toMatchObject({
      key: item.key,
      contentHash: contentHash(secretContent),
      findings: scanSecrets(secretContent),
    });
    expect(JSON.stringify(audit.rows)).not.toContain(secret);
  });

  it("quản trị đội không quản lý tài liệu tổ chức; quản trị tổ chức giải quyết được", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f, { scope: "org" });
    await expect(
      as(f, "tadmin", (tx) =>
        resolveConflict(tx, user(f), { id: conflictId(item), choice: "hub", baseVersion: 2 }, enqueue),
      ),
    ).rejects.toMatchObject({ code: "ORG_ROLE_REQUIRED" });
    expect(
      await as(f, "admin", (tx) =>
        resolveConflict(tx, user(f, "admin"), { id: conflictId(item), choice: "repo", baseVersion: 2 }, enqueue),
      ),
    ).toEqual({ key: item.key, version: 3 });
  });

  it("xung đột nhận nội dung repo mới trước khi giải quyết; cursor sai báo lỗi nghiệp vụ", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f);
    const updatedContent = "# Hướng dẫn\n\nRepo vừa sửa lần nữa.\n";
    const updatedCommit = "c".repeat(40);
    await as(f, "admin", (tx) =>
      tx
        .update(docConflicts)
        .set({ repoContent: updatedContent, repoCommit: updatedCommit })
        .where(eq(docConflicts.id, conflictId(item))),
    );
    expect(await as(f, "tadmin", (tx) => getConflict(tx, user(f), conflictId(item)))).toMatchObject({
      repoContent: updatedContent,
      repoCommit: updatedCommit,
    });
    await as(f, "tadmin", (tx) =>
      resolveConflict(tx, user(f), { id: conflictId(item), choice: "repo", baseVersion: 2 }, enqueue),
    );
    expect((await saved(f, item.key)).content).toBe(updatedContent);
    expect(await state(f, item.docId)).toMatchObject({
      syncedHash: contentHash(updatedContent),
      syncedCommit: updatedCommit,
    });
    await expect(as(f, "tadmin", (tx) => listConflicts(tx, user(f), { cursor: "khong-hop-le" }))).rejects.toMatchObject(
      { code: "DOCSYNC_INVALID_CURSOR" },
    );
  });

  it("chọn bản repo có bí mật giữ cờ blocked_secret và không xếp đẩy", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f, { content: secretContent });
    await as(f, "tadmin", (tx) =>
      resolveConflict(tx, user(f), { id: conflictId(item), choice: "repo", baseVersion: 2 }, async () => {
        throw new Error("Không được xếp đẩy bí mật.");
      }),
    );
    expect(await state(f, item.docId)).toMatchObject({ state: "blocked_secret" });
    expect(await versionRow(item.docId, 3)).toMatchObject({ secret_flag: true });
  });

  it("lỗi xếp job rollback cả phiên bản, xung đột và audit", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f);
    await expect(
      as(f, "tadmin", (tx) =>
        resolveConflict(tx, user(f), { id: conflictId(item), choice: "hub", baseVersion: 2 }, async () => {
          throw new Error("Hàng đợi lỗi.");
        }),
      ),
    ).rejects.toThrow("Hàng đợi lỗi.");
    expect((await saved(f, item.key)).version).toBe(2);
    expect(await state(f, item.docId)).toMatchObject({ state: "conflict" });
    expect(await as(f, "tadmin", (tx) => getConflict(tx, user(f), conflictId(item)))).toMatchObject({ state: "open" });
    expect(
      (
        await admin.query("select 1 from hive.audit_log where target_id = $1 and action = 'doc.conflict_resolve'", [
          item.docId,
        ])
      ).rows,
    ).toHaveLength(0);
  });

  it("rollback transaction sau khi xếp job không để lại job hay phiên bản", async () => {
    const f = fixtures.github;
    // Dọn job của đúng nhà test để phép kiểm không bị singleton của test trước che khuất.
    await admin.query("delete from pgboss.job where name = $1 and singleton_key = $2", [DOCSYNC_PUSH_QUEUE, f.home.id]);
    const item = await seedConflict(f);
    await expect(
      as(f, "tadmin", async (tx) => {
        await resolveConflict(tx, user(f), { id: conflictId(item), choice: "hub", baseVersion: 2 }, enqueue);
        throw new Error("Huỷ transaction.");
      }),
    ).rejects.toThrow("Huỷ transaction.");
    expect((await saved(f, item.key)).version).toBe(2);
    expect(
      (
        await admin.query("select 1 from pgboss.job where name = $1 and singleton_key = $2", [
          DOCSYNC_PUSH_QUEUE,
          f.home.id,
        ])
      ).rows,
    ).toHaveLength(0);
  });
});

describe("file bị xoá trên repo", () => {
  it("quyết định qua docId đóng cả xung đột còn mở trước khi file bị xoá", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f);
    await as(f, "admin", (tx) =>
      tx.update(docRepoFiles).set({ state: "deleted_in_repo" }).where(eq(docRepoFiles.docId, item.docId)),
    );
    await as(f, "tadmin", (tx) =>
      resolveConflict(tx, user(f), { id: item.docId, choice: "repo", baseVersion: 2 }, enqueue),
    );
    const rows = await as(f, "admin", (tx) =>
      tx
        .select()
        .from(docConflicts)
        .where(eq(docConflicts.id, conflictId(item))),
    );
    expect(rows[0]).toMatchObject({ state: "resolved", resolution: "repo", resolvedVersion: 2 });
  });

  it("chọn hub qua docId ghi lại nội dung, xoá hash base và xếp đẩy", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f, { deleted: true });
    await as(f, "tadmin", (tx) =>
      resolveConflict(tx, user(f), { id: item.docId, choice: "hub", baseVersion: 2 }, enqueue),
    );
    expect(await saved(f, item.key)).toMatchObject({ content: hubContent, version: 3 });
    expect(await state(f, item.docId)).toMatchObject({
      state: "pending",
      syncedHash: null,
      repoHash: null,
      syncedCommit: null,
    });
  });

  it("chọn repo qua docId lưu trữ trên hub, giữ lịch sử và không ghi lại file", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f, { deleted: true });
    expect(
      await as(f, "tadmin", (tx) =>
        resolveConflict(tx, user(f), { id: item.docId, choice: "repo", baseVersion: 2 }, async () => {
          throw new Error("Không được ghi lại file đã xoá.");
        }),
      ),
    ).toEqual({ key: item.key, version: 2 });
    expect(await as(f, "tadmin", (tx) => listDocs(tx, user(f), {}))).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: item.key })]),
    );
    expect(await as(f, "tadmin", (tx) => getDoc(tx, user(f), { key: item.key, version: 2 }))).toMatchObject({
      content: hubContent,
    });
    expect(await state(f, item.docId)).toMatchObject({ state: "synced", syncedVersion: 2, syncedHash: null });
  });

  it("chặn base cũ, sửa tay và thành viên không có quyền", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f, { deleted: true });
    for (const input of [
      { id: item.docId, choice: "hub" as const, baseVersion: 1 },
      { id: item.docId, choice: "manual" as const, baseVersion: 2, content: "x" },
    ])
      await expect(as(f, "tadmin", (tx) => resolveConflict(tx, user(f), input, enqueue))).rejects.toBeInstanceOf(Error);
    await expect(
      as(f, "tmember", (tx) =>
        resolveConflict(tx, user(f, "tmember"), { id: item.docId, choice: "repo", baseVersion: 2 }, enqueue),
      ),
    ).rejects.toMatchObject({ code: "TEAM_ROLE_REQUIRED" });
    expect((await saved(f, item.key)).version).toBe(2);
    expect(await state(f, item.docId)).toMatchObject({ state: "deleted_in_repo" });
  });
});

describe("router xung đột", () => {
  function routes(f: Fixture, withJobs = true) {
    const auth = {
      api: {
        getSession: async () => ({ user: { id: f.org.user("tadmin"), name: "Quản trị", email: "admin@seed.test" } }),
      },
    } as unknown as Auth;
    return conflictsRoutes({ pool, auth, ...(withJobs ? { jobs } : {}) });
  }
  const context = (f: Fixture) => ({ headers: new Headers({ "x-hive-org": f.org.orgId }) });

  it("nối list/get/resolve với middleware tổ chức và trả findings đã khai báo", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f);
    const api = routes(f);
    expect((await call(api.list, { limit: 200 }, { context: context(f) })).items.map((i) => i.id)).toContain(
      conflictId(item),
    );
    expect(await call(api.get, { id: conflictId(item) }, { context: context(f) })).toMatchObject({
      key: item.key,
      baseContent,
    });
    await expect(
      call(
        api.resolve,
        { id: conflictId(item), choice: "manual", baseVersion: 2, content: secretContent },
        { context: context(f) },
      ),
    ).rejects.toMatchObject({ code: "DOC_SECRET_FOUND", data: { findings: scanSecrets(secretContent) } });
    expect(
      await call(api.resolve, { id: conflictId(item), choice: "hub", baseVersion: 2 }, { context: context(f) }),
    ).toEqual({ key: item.key, version: 3 });
  });

  it("không có hàng đợi thì rollback thay vì báo thành công", async () => {
    const f = fixtures.gitlab;
    const item = await seedConflict(f);
    await expect(
      call(routes(f, false).resolve, { id: conflictId(item), choice: "hub", baseVersion: 2 }, { context: context(f) }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect((await saved(f, item.key)).version).toBe(2);
    expect(await state(f, item.docId)).toMatchObject({ state: "conflict" });
  });
});
