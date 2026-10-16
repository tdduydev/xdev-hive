import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { call, ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import type { Auth } from "../identity/index.ts";
import { provideDocIndexJobs, saveDoc } from "../knowledge/index.ts";
import { McpToolRegistry } from "../mcp/index.ts";
import {
  createPool,
  createPostgresBlobStore,
  type Jobs,
  parseMasterKey,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import { createMemoryProvider } from "../scm/index.ts";
import { EXTRACT_LIMITS } from "./extract/types.ts";
import {
  approvedExtractOf,
  approveExtract,
  confirmExtractSecret,
  ExtractSecretError,
  getExtract,
  listExtracts,
  rejectExtract,
  runExtractJob,
  sweepOrg,
  updateExtract,
} from "./extracts.ts";
import { configureProjectHome } from "./homes.ts";
import { registerMcpTools } from "./mcp-tools.ts";
import { DOCSYNC_EXTRACT_QUEUE } from "./queues.ts";
import { extractsRoutes } from "./routes/extracts.ts";
import { docAssets, docExtracts } from "./schema.ts";

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
let homeId: string;
const key = `dx${tag}`;
const guide = `project/${key}/huong-dan`;
const user = (name: string) => ({ kind: "user" as const, userId: org.user(name) });
const as = <T>(name: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pool, { userId: org.user(name), orgId: org.orgId }, fn);
const asOrg = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(pool, { orgId: org.orgId }, fn);
const fixture = (name: string) => readFile(new URL(`./fixtures/extract/${name}`, import.meta.url));
const SECRET_CSV = `ten,khoa\nbuild,AKIA${"Q".repeat(16)}\n`;

async function putBlob(tx: Tx, bytes: Uint8Array, mediaType: string) {
  return createPostgresBlobStore().put(
    tx,
    org.orgId,
    (async function* () {
      yield bytes;
    })(),
    mediaType,
    { maxBytes: 1024 ** 2 },
  );
}

async function seedAsset(name: string, bytes: Uint8Array, mediaType: string): Promise<string> {
  return asOrg(async (tx) => {
    const blob = await putBlob(tx, bytes, mediaType);
    const [asset] = await tx
      .insert(docAssets)
      .values({
        orgId: org.orgId,
        homeId,
        repoPath: `docs/assets/${name}`,
        blobId: blob.id,
        mediaType,
        size: blob.size,
        sha256: blob.sha256,
      })
      .returning({ id: docAssets.id });
    if (!asset) throw new Error("không tạo được asset");
    return asset.id;
  });
}

async function replaceBlob(assetId: string, bytes: Uint8Array, mediaType: string) {
  await asOrg(async (tx) => {
    const blob = await putBlob(tx, bytes, mediaType);
    await tx
      .update(docAssets)
      .set({ blobId: blob.id, size: blob.size, sha256: blob.sha256 })
      .where(eq(docAssets.id, assetId));
  });
}

/** Lượt quét rồi chạy job cho mọi bản trích vừa xếp, như cron và worker pg-boss làm. */
async function sweepAndRun(run?: Parameters<typeof runExtractJob>[0]["run"]) {
  queued.length = 0;
  await asOrg((tx) => sweepOrg(tx, jobs, org.orgId));
  const extractJobs = queued
    .filter((q) => q.queue === DOCSYNC_EXTRACT_QUEUE)
    .map((q) => q.data as { orgId: string; assetId: string; extractId: string });
  const results = new Map<string, string>();
  for (const job of extractJobs)
    results.set(job.assetId, await runExtractJob({ ...deps, ...(run ? { run } : {}) }, job));
  return results;
}

const extractsOf = (assetId: string) =>
  asOrg((tx) => tx.select().from(docExtracts).where(eq(docExtracts.assetId, assetId)));
const latest = async (assetId: string) => {
  const rows = await extractsOf(assetId);
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
};
const action = (row: { id: string; updatedAt: Date }) => ({ id: row.id, updatedAt: row.updatedAt.toISOString() });
const audits = async (action: string, targetId: string) =>
  (
    await admin.query(
      "select actor_user_id, data from hive.audit_log where org_id = $1 and action = $2 and target_id = $3",
      [org.orgId, action, targetId],
    )
  ).rows;

beforeAll(async () => {
  org = await seedOrg(admin, `dx-${tag}`);
  project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key,
  });
  mem.seedRepo({ owner: project.owner, name: project.repo }, { files: { "docs/a.md": "# A\n" } });
  const home = await as("tadmin", (tx) =>
    configureProjectHome(
      tx,
      deps,
      { userId: org.user("tadmin"), orgId: org.orgId },
      {
        project: key,
        settings: {
          enabled: true,
          root: "docs/",
          repoSync: "pr",
          include: ["**/*.md"],
          exclude: [],
          assetsDir: "assets",
          repoChangesNeedReview: false,
        },
      },
    ),
  );
  homeId = home.id;
  await as("tadmin", (tx) =>
    saveDoc(tx, user("tadmin"), {
      key: guide,
      title: "Hướng dẫn",
      content: "# Hướng dẫn\n\n[Bảng](assets/bang.csv) và [bản khoá](assets/khoa.pdf)\n",
      baseVersion: 0,
    }),
  );
  provideDocIndexJobs(jobs);
});

afterAll(async () => {
  provideDocIndexJobs(undefined);
  await Promise.all([admin.end(), pool.end()]);
});

describe("job trích nội dung", () => {
  let csvId: string;

  beforeEach(() => {
    queued.length = 0;
  });

  it("quét tạo bản pending, job trích xong thì chờ duyệt và báo quản trị đội", async () => {
    csvId = await seedAsset("bang.csv", await fixture("sample.csv"), "text/csv");
    expect(await sweepAndRun()).toEqual(new Map([[csvId, "review"]]));
    const row = await latest(csvId);
    expect(row).toMatchObject({ state: "review", secretFlag: false, warnings: [] });
    expect(row?.content).toContain("| An | Quản trị | Có ; trong ô |");
    const { rows } = await admin.query(
      "select user_id, event, link from hive.inbox_items where org_id = $1 and event_key = $2",
      [org.orgId, `docsync.extract_review:${row?.id}`],
    );
    expect(rows).toContainEqual({
      user_id: org.user("tadmin"),
      event: "docsync.extract_review",
      link: "https://hive.example/docs",
    });
    expect(rows.map((r) => r.user_id)).not.toContain(org.user("tmember"));
    // Nội dung không đổi thì lượt quét sau không tạo bản mới.
    expect((await sweepAndRun()).size).toBe(0);
  });

  it("PDF có mật khẩu và zip bomb chỉ làm bản trích thất bại, hub vẫn chạy", async () => {
    const pdfId = await seedAsset("khoa.pdf", await fixture("encrypted.pdf"), "application/pdf");
    const bombId = await seedAsset("bom.docx", await fixture("bomb.docx"), "application/octet-stream");
    const results = await sweepAndRun({ limits: { ...EXTRACT_LIMITS, unzippedBytes: 8 * 1024 ** 2 } });
    expect(results.get(pdfId)).toBe("failed");
    expect(results.get(bombId)).toBe("failed");
    expect(await latest(pdfId)).toMatchObject({ state: "failed", error: "PDF có mật khẩu, không trích được." });
    expect((await latest(bombId))?.error).toMatch(/zip bomb/);
    // Bản đã thất bại cho nội dung hiện tại thì không trích lại tới khi file đổi.
    expect((await sweepAndRun()).size).toBe(0);
  });

  it("duyệt ghi audit, xếp chỉ mục; agent chỉ đọc được bản đã duyệt", async () => {
    const row = await latest(csvId);
    if (!row) throw new Error("thiếu bản trích");
    const registry = new McpToolRegistry();
    registerMcpTools(registry);
    const tool = registry.list().find((t) => t.name === "doc_asset_get");
    if (!tool) throw new Error("thiếu tool doc_asset_get");
    const read = (path: string) =>
      as("tmember", (tx) =>
        tool.handler(
          { docKey: guide, path },
          { tx, orgId: org.orgId, principal: { kind: "user", userId: org.user("tmember"), scopes: [] } },
          undefined,
        ),
      );
    await expect(read("assets/bang.csv")).rejects.toMatchObject({ code: "DOCSYNC_EXTRACT_NOT_APPROVED" });

    const approved = await as("tadmin", (tx) => approveExtract(tx, user("tadmin"), action(row)));
    expect(approved).toMatchObject({ state: "approved", reviewedBy: org.user("tadmin") });
    expect(await audits("doc.extract_approve", row.id)).toEqual([
      expect.objectContaining({ actor_user_id: org.user("tadmin") }),
    ]);
    expect(queued).toContainEqual({ queue: "knowledge-doc-index", data: { orgId: org.orgId, extractId: row.id } });
    expect(await read("assets/bang.csv")).toMatchObject({
      repoPath: "docs/assets/bang.csv",
      stale: false,
      offset: 0,
      nextOffset: null,
      content: row.content,
    });
    // Bản thất bại không bao giờ tới agent.
    await expect(read("assets/khoa.pdf")).rejects.toMatchObject({ code: "DOCSYNC_EXTRACT_NOT_APPROVED" });
  });

  it("file đổi: bản đã duyệt giữ tới khi bản mới được duyệt", async () => {
    const old = await as("tadmin", (tx) => approvedExtractOf(tx, csvId));
    await replaceBlob(csvId, Buffer.from("a,b\n1,2\n"), "text/csv");
    expect(await sweepAndRun()).toEqual(new Map([[csvId, "review"]]));
    expect((await as("tadmin", (tx) => approvedExtractOf(tx, csvId)))?.id).toBe(old?.id);

    const fresh = await latest(csvId);
    if (!fresh || !old) throw new Error("thiếu bản trích");
    expect(fresh.content).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
    await as("tadmin", (tx) => approveExtract(tx, user("tadmin"), action(fresh)));
    const rows = new Map((await extractsOf(csvId)).map((r) => [r.id, r]));
    expect(rows.get(old.id)).toMatchObject({ state: "rejected", error: "Đã thay bằng bản trích mới hơn." });
    expect(rows.get(fresh.id)?.state).toBe("approved");
    expect(await audits("doc.extract_approve", fresh.id)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ replaced: [old.id] }) }),
    ]);
  });

  it("file đổi lúc bản cũ còn chờ duyệt: bản cũ thất bại, không duyệt được nữa", async () => {
    const id = await seedAsset("cu.csv", Buffer.from("x\n1\n"), "text/csv");
    await sweepAndRun();
    const stale = await latest(id);
    if (!stale) throw new Error("thiếu bản trích");
    await replaceBlob(id, Buffer.from("x\n2\n"), "text/csv");
    await expect(as("tadmin", (tx) => approveExtract(tx, user("tadmin"), action(stale)))).rejects.toMatchObject({
      code: "DOCSYNC_EXTRACT_STALE",
    });
    await sweepAndRun();
    const rows = new Map((await extractsOf(id)).map((r) => [r.id, r]));
    expect(rows.get(stale.id)).toMatchObject({ state: "failed", error: "Đã có bản trích mới hơn của file này." });
    expect([...rows.values()].filter((r) => r.state === "review")).toHaveLength(1);
  });
});

describe("bí mật trong bản trích", () => {
  it("chặn duyệt tới khi sửa hoặc xác nhận; xác nhận ghi audit", async () => {
    const id = await seedAsset("bi-mat.csv", Buffer.from(SECRET_CSV), "text/csv");
    await sweepAndRun();
    const row = await latest(id);
    if (!row) throw new Error("thiếu bản trích");
    expect(row).toMatchObject({ state: "review", secretFlag: true });
    const view = await as("tadmin", (tx) => getExtract(tx, user("tadmin"), row.id));
    expect(view.findings).toEqual([expect.objectContaining({ kind: "aws_access_key" })]);

    const error = await as("tadmin", (tx) => approveExtract(tx, user("tadmin"), action(row))).catch((e) => e);
    expect(error).toBeInstanceOf(ExtractSecretError);
    expect(error.findings).toHaveLength(1);

    const confirmed = await as("tadmin", (tx) => confirmExtractSecret(tx, user("tadmin"), action(row)));
    expect(confirmed).toMatchObject({ secretFlag: false, findings: [] });
    expect(await audits("doc.secrets.acknowledge", row.id)).toEqual([
      {
        actor_user_id: org.user("tadmin"),
        data: expect.objectContaining({ findings: [expect.objectContaining({ kind: "aws_access_key" })] }),
      },
    ]);
    const approved = await as("tadmin", (tx) =>
      approveExtract(tx, user("tadmin"), { id: row.id, updatedAt: confirmed.updatedAt }),
    );
    expect(approved.state).toBe("approved");
  });

  it("sửa nội dung thì quét lại; bản đã cũ báo xung đột; từ chối ghi audit", async () => {
    const id = await seedAsset("sua.csv", Buffer.from("a\n1\n"), "text/csv");
    await sweepAndRun();
    const row = await latest(id);
    if (!row) throw new Error("thiếu bản trích");
    const edited = await as("tadmin", (tx) =>
      updateExtract(tx, user("tadmin"), { ...action(row), content: `Khoá AKIA${"Z".repeat(16)}` }),
    );
    expect(edited.secretFlag).toBe(true);
    await expect(as("tadmin", (tx) => rejectExtract(tx, user("tadmin"), action(row)))).rejects.toMatchObject({
      code: "DOCSYNC_EXTRACT_CHANGED",
    });
    const cleaned = await as("tadmin", (tx) =>
      updateExtract(tx, user("tadmin"), { id: row.id, updatedAt: edited.updatedAt, content: "Không còn khoá." }),
    );
    expect(cleaned).toMatchObject({ secretFlag: false, findings: [] });
    const rejected = await as("tadmin", (tx) =>
      rejectExtract(tx, user("tadmin"), { id: row.id, updatedAt: cleaned.updatedAt }),
    );
    expect(rejected.state).toBe("rejected");
    expect(await audits("doc.extract_reject", row.id)).toEqual([
      { actor_user_id: org.user("tadmin"), data: expect.objectContaining({ previousState: "review" }) },
    ]);
  });
});

describe("quyền duyệt", () => {
  it("người không quản lý nhà thấy như không có; agent không duyệt được", async () => {
    const id = await seedAsset("quyen.csv", Buffer.from("a\n1\n"), "text/csv");
    await sweepAndRun();
    const row = await latest(id);
    if (!row) throw new Error("thiếu bản trích");
    expect((await as("tadmin", (tx) => listExtracts(tx, user("tadmin"), { state: "review" }))).items).toContainEqual(
      expect.objectContaining({ id: row.id, repoPath: "docs/assets/quyen.csv", homeId }),
    );
    for (const who of ["tmember", "oadmin", "loner"]) {
      expect((await as(who, (tx) => listExtracts(tx, user(who), {}))).items).toEqual([]);
      await expect(as(who, (tx) => getExtract(tx, user(who), row.id))).rejects.toMatchObject({
        code: "DOCSYNC_EXTRACT_NOT_FOUND",
      });
    }
    await expect(
      as("tadmin", (tx) =>
        approveExtract(tx, { kind: "run", runId: randomUUID(), projectId: project.projectId }, action(row)),
      ),
    ).rejects.toMatchObject({ code: "RUN_NOT_ALLOWED" });
  });
});

describe("router bản trích", () => {
  it("duyệt bản có bí mật trả DOC_SECRET_FOUND kèm findings", async () => {
    const id = await seedAsset("route.csv", Buffer.from(SECRET_CSV), "text/csv");
    await sweepAndRun();
    const row = await latest(id);
    if (!row) throw new Error("thiếu bản trích");
    const auth = {
      api: { getSession: async () => ({ user: { id: org.user("tadmin"), name: "Quản trị", email: "a@seed.test" } }) },
    } as unknown as Auth;
    const api = extractsRoutes({ pool, auth, jobs });
    const context = { headers: new Headers({ "x-hive-org": org.orgId }) };
    expect((await call(api.get, { id: row.id }, { context })).findings).toHaveLength(1);
    const error = await call(api.approve, action(row), { context }).catch((e) => e);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code: "DOC_SECRET_FOUND",
      status: 400,
      data: { code: "DOC_SECRET_FOUND", findings: [expect.objectContaining({ kind: "aws_access_key" })] },
    });
  });
});
