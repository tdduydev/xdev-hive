import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { freshDatabase } from "../../../test/seed.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import type { Principal } from "./access.ts";
import {
  DOC_INDEX_QUEUE,
  type DocIndexJob,
  EMBEDDING_SKIPPED,
  indexExtract,
  provideDocIndexJobs,
  resetDocBackfillCheck,
  runDocIndex,
  searchDocs,
} from "./doc-search.ts";
import { archiveDoc, restoreDoc, saveDoc, saveDocFromSync } from "./docs.ts";
import type { Embedder } from "./embedder.ts";

// Như vector.db.test.ts: mỗi trường hợp có/không pgvector dựng một database riêng; image không có pgvector thì bỏ
// phần tìm theo vector.

const db = inject("db");
const probe = new pg.Pool({ connectionString: db.adminUrl, max: 1 });
const available =
  ((await probe.query("select 1 from pg_available_extensions where name = 'vector'")).rowCount ?? 0) > 0;
await probe.end();
if (!available) console.warn("Image Postgres của test không có pgvector: bỏ qua phần kiểm tìm tài liệu theo vector.");

const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
// Ghép lúc chạy để mã nguồn không chứa chuỗi giống khoá thật (máy quét bí mật của repo sẽ báo nhầm).
const FAKE_KEY = `AKIA${"Q".repeat(16)}`;

/** Embedder giả theo chủ đề như vector.db.test.ts; ghi lại văn bản đã gửi để kiểm nội dung không được rời hub. */
function fakeEmbedder(model = "gia-lap-v1"): Embedder & { calls: number; seen: string[] } {
  const topics = [
    ["postgres", "cơ sở dữ liệu", "database"],
    ["triển khai", "deploy", "release", "phát hành"],
    ["kiểm thử", "test"],
  ];
  return {
    model,
    calls: 0,
    seen: [],
    async embed(texts) {
      this.calls += 1;
      this.seen.push(...texts);
      return texts.map((t) => {
        const s = t.toLowerCase();
        return [...topics.map((words) => (words.some((w) => s.includes(w)) ? 1 : 0)), 0.05];
      });
    },
  };
}

function fakeJobs(): Jobs & { sent: Array<{ data: DocIndexJob; inTx: boolean; singletonKey?: string }> } {
  const sent: Array<{ data: DocIndexJob; inTx: boolean; singletonKey?: string }> = [];
  return {
    sent,
    start: async () => {},
    stop: async () => {},
    schedule: async () => {},
    work: async () => {},
    async enqueue(queue, data, opts) {
      if (queue === DOC_INDEX_QUEUE)
        sent.push({ data: data as DocIndexJob, inTx: opts?.tx !== undefined, singletonKey: opts?.singletonKey });
      return randomUUID();
    },
  };
}

interface Env {
  admin: pg.Pool;
  app: pg.Pool;
  org: OrgFixture & { user: (n: string) => string };
  projectKey: string;
  projectId: string;
  connectionId: string;
}

async function setupEnv(pgvector: boolean): Promise<Env> {
  const urls = await freshDatabase(db, { pgvector });
  const admin = new pg.Pool({ connectionString: urls.adminUrl });
  const app = createPool(urls.appUrl);
  const org = await seedOrg(admin, "dsearch");
  const projectKey = "hoa-don";
  const { projectId, connectionId } = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  return { admin, app, org, projectKey, projectId, connectionId };
}

const user = (env: Env, who: string): Principal => ({ kind: "user", userId: env.org.user(who) });
const run = (env: Env): Principal => ({ kind: "run", runId: randomUUID(), projectId: env.projectId });
const as = <T>(env: Env, who: string | null, fn: (tx: Tx) => Promise<T>) =>
  withTenant(env.app, { userId: who ? env.org.user(who) : undefined, orgId: env.org.orgId }, fn);

const save = (env: Env, who: string, key: string, content: string, baseVersion = 0) =>
  as(env, who, (tx) => saveDoc(tx, user(env, who), { key, content, baseVersion }));

/** Chạy hết job chỉ mục đã xếp, như worker. */
async function drain(env: Env, jobs: ReturnType<typeof fakeJobs>, embedder?: Embedder) {
  while (jobs.sent.length) {
    const batch = jobs.sent.splice(0);
    for (const { data } of batch) await runDocIndex({ pool: env.app, embedder }, data, undefined, jobs);
  }
}

const search = (env: Env, who: string | Principal, query: string, extra: Record<string, unknown> = {}, embedder?: Embedder) =>
  as(env, typeof who === "string" ? who : null, (tx) =>
    searchDocs(tx, typeof who === "string" ? user(env, who) : who, { query, ...extra }, { embedder }),
  );

const keys = (out: { hits: Array<{ key: string }> }) => out.hits.map((h) => h.key);

async function chunkRows(env: Env, docId: string) {
  const { rows } = await env.admin.query(
    "select version, ord, heading_path, content, embedding_model from hive.doc_chunks where doc_id = $1 order by version, ord",
    [docId],
  );
  return rows as Array<{ version: number; ord: number; heading_path: string[]; content: string; embedding_model: string | null }>;
}

/** Bản trích đã duyệt của một ảnh đính kèm tài liệu; bảng của docsync nên chèn thẳng bằng admin. */
async function seedExtract(env: Env, ownerDocId: string, content: string, state = "approved") {
  const sha = createHash("sha256").update(randomUUID()).digest("hex");
  const home = randomUUID();
  const blob = randomUUID();
  const asset = randomUUID();
  const extract = randomUUID();
  const orgId = env.org.orgId;
  await env.admin.query(
    `insert into hive.doc_homes (id, org_id, scope, connection_id, owner, name, branch, configured_by)
     values ($1, $2, 'org', $3, 'org', $4, 'main', $5)`,
    [home, orgId, env.connectionId, `docs-${home.slice(0, 6)}`, env.org.user("admin")],
  );
  await env.admin.query(
    "insert into hive.blobs (id, org_id, sha256, size, media_type, chunk_count) values ($1, $2, $3, 3, 'image/png', 1)",
    [blob, orgId, sha],
  );
  await env.admin.query(
    `insert into hive.doc_assets (id, org_id, home_id, repo_path, blob_id, media_type, size, sha256, owner_doc_id)
     values ($1, $2, $3, 'docs/assets/so-do.png', $4, 'image/png', 3, $5, $6)`,
    [asset, orgId, home, blob, sha, ownerDocId],
  );
  await env.admin.query(
    "insert into hive.doc_extracts (id, org_id, asset_id, source_sha256, content, state) values ($1, $2, $3, $4, $5, $6)",
    [extract, orgId, asset, sha, content, state],
  );
  return { asset, extract };
}

describe("không có pgvector: chỉ tìm theo từ", () => {
  let env: Env;
  let jobs: ReturnType<typeof fakeJobs>;
  beforeAll(async () => {
    env = await setupEnv(false);
  });
  beforeEach(() => {
    jobs = fakeJobs();
    provideDocIndexJobs(jobs);
    resetDocBackfillCheck();
  });
  afterEach(() => provideDocIndexJobs(undefined));
  afterAll(async () => {
    await Promise.all([env.admin.end(), env.app.end()]);
  });

  it("lưu xếp job trong transaction; chạy job thì chia đoạn theo tiêu đề và tìm được", async () => {
    const doc = await save(env, "tadmin", "team/thanh-toan/doi-soat", "# Đối soát\n\nĐối soát giao dịch cuối ngày.\n\n## Lỗi lệch\n\nGhi nhận chênh lệch.");
    expect(jobs.sent).toEqual([{ data: { orgId: env.org.orgId, docId: doc.id }, inTx: true, singletonKey: `doc:${doc.id}` }]);
    await drain(env, jobs);
    expect(await chunkRows(env, doc.id)).toEqual([
      { version: 1, ord: 0, heading_path: ["Đối soát"], content: "# Đối soát\n\nĐối soát giao dịch cuối ngày.", embedding_model: null },
      { version: 1, ord: 1, heading_path: ["Đối soát", "Lỗi lệch"], content: "## Lỗi lệch\n\nGhi nhận chênh lệch.", embedding_model: null },
    ]);
    const embedder = fakeEmbedder();
    const out = await search(env, "tmember", "chênh lệch", {}, embedder);
    expect(out).toEqual({
      mode: "keyword",
      hits: [
        {
          key: "team/thanh-toan/doi-soat",
          title: "doi-soat",
          headingPath: ["Đối soát", "Lỗi lệch"],
          snippet: "## Lỗi lệch Ghi nhận chênh lệch.",
          repoPath: null,
          extractId: null,
        },
      ],
    });
    expect(embedder.calls).toBe(0);
  });

  it("phiên bản mới thay đoạn cũ; lưu trữ gỡ khỏi tìm kiếm, khôi phục thì có lại", async () => {
    const key = "team/thanh-toan/quy-trinh";
    const v1 = await save(env, "tadmin", key, "Quy trình hoàn tiền cũ.");
    await save(env, "tadmin", key, "Quy trình đổi trả mới.", v1.version);
    await drain(env, jobs);
    expect((await chunkRows(env, v1.id)).map((c) => [c.version, c.content])).toEqual([[2, "Quy trình đổi trả mới."]]);
    expect(keys(await search(env, "tmember", "hoàn tiền"))).toEqual([]);
    expect(keys(await search(env, "tmember", "đổi trả"))).toEqual([key]);

    await as(env, "tadmin", (tx) => archiveDoc(tx, user(env, "tadmin"), { key, baseVersion: 2 }));
    // Chưa chạy job vẫn ẩn: tìm kiếm lọc tài liệu lưu trữ.
    expect(keys(await search(env, "tmember", "đổi trả"))).toEqual([]);
    await drain(env, jobs);
    expect(await chunkRows(env, v1.id)).toEqual([]);

    await as(env, "tadmin", (tx) => restoreDoc(tx, user(env, "tadmin"), { key, baseVersion: 2 }));
    await drain(env, jobs);
    expect(keys(await search(env, "tmember", "đổi trả"))).toEqual([key]);
  });

  it("lọc theo quyền đọc và phạm vi", async () => {
    await save(env, "admin", "org/so-tay/phan-quyen", "Phân quyền chung toàn công ty.");
    await save(env, "tadmin", "team/thanh-toan/phan-quyen", "Phân quyền đội thanh toán.");
    await save(env, "tadmin", `project/${env.projectKey}/phan-quyen`, "Phân quyền dự án hoá đơn.");
    await save(env, "oadmin", "team/crm/phan-quyen", "Phân quyền đội CRM.");
    await drain(env, jobs);

    const all = ["org/so-tay/phan-quyen", "team/thanh-toan/phan-quyen", `project/${env.projectKey}/phan-quyen`];
    expect(keys(await search(env, "tmember", "phân quyền")).sort()).toEqual([...all].sort());
    expect(keys(await search(env, "oadmin", "phân quyền")).sort()).toEqual(["org/so-tay/phan-quyen", "team/crm/phan-quyen"]);
    expect(keys(await search(env, "loner", "phân quyền"))).toEqual(["org/so-tay/phan-quyen"]);
    expect(keys(await search(env, run(env), "phân quyền")).sort()).toEqual([...all].sort());

    expect(keys(await search(env, "tmember", "phân quyền", { scope: "org" }))).toEqual(["org/so-tay/phan-quyen"]);
    expect(keys(await search(env, "tmember", "phân quyền", { scope: "team" }))).toEqual(["team/thanh-toan/phan-quyen"]);
    expect(keys(await search(env, "tmember", "phân quyền", { scope: "project" }))).toEqual([
      `project/${env.projectKey}/phan-quyen`,
    ]);
    expect(keys(await search(env, "tmember", "phân quyền", { limit: 1 }))).toHaveLength(1);
  });

  it("tài liệu có dấu hiệu bí mật: người thấy, run không thấy", async () => {
    const key = `project/${env.projectKey}/cau-hinh-cong`;
    await as(env, null, (tx) =>
      saveDocFromSync(tx, {
        key,
        content: `# Cấu hình cổng\n\nKhoá cổng thanh toán: ${FAKE_KEY}\n`,
        baseVersion: 0,
        scope: { teamId: env.org.teamId, projectId: env.projectId },
        source: "import",
      }),
    );
    await drain(env, jobs);
    expect(keys(await search(env, "tviewer", "cổng"))).toEqual([key]);
    expect(keys(await search(env, run(env), "cổng"))).toEqual([]);
  });

  it("bản trích đã duyệt tìm được kèm đường dẫn; từ chối thì gỡ", async () => {
    const doc = await save(env, "tadmin", "team/thanh-toan/kien-truc", "# Kiến trúc\n\nXem sơ đồ.");
    const { extract } = await seedExtract(env, doc.id, "Sơ đồ luồng tiền giữa ngân hàng và ví.");
    await as(env, "tadmin", (tx) => indexExtract(tx, extract));
    expect(jobs.sent.map((j) => j.data)).toContainEqual({ orgId: env.org.orgId, extractId: extract });
    await drain(env, jobs);
    expect((await search(env, "tmember", "ngân hàng")).hits).toEqual([
      expect.objectContaining({ key: "team/thanh-toan/kien-truc", extractId: extract, repoPath: "docs/assets/so-do.png" }),
    ]);
    expect(keys(await search(env, "oadmin", "ngân hàng"))).toEqual([]);

    await env.admin.query("update hive.doc_extracts set state = 'rejected' where id = $1", [extract]);
    expect(keys(await search(env, "tmember", "ngân hàng"))).toEqual([]);
    await as(env, "tadmin", (tx) => indexExtract(tx, extract));
    await drain(env, jobs);
    expect((await env.admin.query("select 1 from hive.doc_chunks where extract_id = $1", [extract])).rowCount).toBe(0);
  });

  it("tài liệu có sẵn chưa có đoạn: lần tìm đầu xếp lượt điền, chạy xong thì tìm được", async () => {
    provideDocIndexJobs(undefined);
    const doc = await save(env, "tadmin", "team/thanh-toan/cu", "Ghi chú vật tư cũ.");
    provideDocIndexJobs(jobs);
    expect(await chunkRows(env, doc.id)).toEqual([]);
    expect(keys(await search(env, "tmember", "vật tư"))).toEqual([]);
    expect(jobs.sent).toEqual([
      { data: { orgId: env.org.orgId, backfill: true }, inTx: true, singletonKey: `backfill:${env.org.orgId}` },
    ]);
    // Trong khoảng chờ không kiểm lại.
    await search(env, "tmember", "vật tư");
    expect(jobs.sent).toHaveLength(1);
    await drain(env, jobs);
    expect(keys(await search(env, "tmember", "vật tư"))).toEqual(["team/thanh-toan/cu"]);
    resetDocBackfillCheck();
    await search(env, "tmember", "vật tư");
    expect(jobs.sent).toEqual([]);
  });

  it("bộ câu hỏi SC-008 chỉ tìm theo từ (số đo tham khảo)", async () => {
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/doc-search-sc008.json", import.meta.url), "utf8"),
    ) as { docs: Array<{ key: string; title: string; content: string }>; questions: Array<{ query: string; expect: string }> };
    for (const d of fixture.docs)
      await as(env, "admin", (tx) =>
        saveDoc(tx, user(env, "admin"), { key: `${d.key}-sc008`, title: d.title, content: d.content, baseVersion: 0 }),
      );
    await drain(env, jobs);
    let top5 = 0;
    for (const q of fixture.questions) {
      const out = await search(env, "admin", q.query, { limit: 5, scope: "org" });
      if (keys(out).includes(`${q.expect}-sc008`)) top5 += 1;
    }
    console.info(`SC-008, chỉ tìm theo từ: ${top5}/${fixture.questions.length} câu có đoạn đúng trong top 5.`);
    expect(top5).toBeGreaterThan(0);
  });
});

describe.runIf(available)("có pgvector: kết hợp full-text và vector", () => {
  let env: Env;
  let jobs: ReturnType<typeof fakeJobs>;
  beforeAll(async () => {
    env = await setupEnv(true);
  });
  beforeEach(() => {
    jobs = fakeJobs();
    provideDocIndexJobs(jobs);
    resetDocBackfillCheck();
  });
  afterEach(() => provideDocIndexJobs(undefined));
  afterAll(async () => {
    await Promise.all([env.admin.end(), env.app.end()]);
  });

  it("tìm theo nghĩa dù không chung từ nào; mode hybrid", async () => {
    const embedder = fakeEmbedder();
    await save(env, "tadmin", "team/thanh-toan/trien-khai", "# Triển khai\n\nChạy script lên máy chủ.");
    await save(env, "tadmin", "team/thanh-toan/csdl", "# Cơ sở dữ liệu\n\nSao lưu mỗi đêm.");
    await drain(env, jobs, embedder);
    expect(await search(env, "tmember", "cách deploy", {}, fakeEmbedder("mo-hinh-khac"))).toEqual({
      mode: "hybrid",
      hits: [],
    });
    const out = await search(env, "tmember", "cách deploy", {}, embedder);
    expect(out.mode).toBe("hybrid");
    expect(keys(out)[0]).toBe("team/thanh-toan/trien-khai");
    expect(keys(await search(env, "tmember", "cách deploy"))).toEqual([]);
    expect(keys(await search(env, "oadmin", "cách deploy", {}, embedder))).toEqual([]);
  });

  it("nội dung bí mật hoặc confidential không gửi đi embedding", async () => {
    const embedder = fakeEmbedder();
    const secret = await as(env, null, (tx) =>
      saveDocFromSync(tx, {
        key: "team/thanh-toan/khoa",
        content: `Khoá triển khai: ${FAKE_KEY}\n`,
        baseVersion: 0,
        scope: { teamId: env.org.teamId, projectId: null },
        source: "import",
      }),
    );
    const confidential = await save(env, "tadmin", "team/thanh-toan/mat", "---\nconfidential: true\n---\nKế hoạch triển khai nội bộ.");
    await drain(env, jobs, embedder);
    expect(embedder.seen.join("\n")).not.toMatch(/AKIA|nội bộ/);
    for (const id of [secret.id, confidential.id])
      expect((await chunkRows(env, id)).map((c) => c.embedding_model)).toEqual([EMBEDDING_SKIPPED]);
    const { rows } = await env.admin.query(
      "select count(*)::int as n from hive.doc_chunks where doc_id = any($1) and embedding is not null",
      [[secret.id, confidential.id]],
    );
    expect(rows[0].n).toBe(0);
    // Vẫn tìm được theo từ cho người đọc được; front-matter không vào chỉ mục.
    expect(keys(await search(env, "tmember", "nội bộ"))).toEqual(["team/thanh-toan/mat"]);
    expect(keys(await search(env, "tmember", "confidential"))).toEqual([]);
  });

  it("bật embedding sau: lượt điền tạo embedding cho đoạn đã có", async () => {
    const doc = await save(env, "tadmin", "team/thanh-toan/kiem-thu", "# Kiểm thử\n\nChạy vitest trước khi mở PR.");
    await drain(env, jobs);
    expect((await chunkRows(env, doc.id)).map((c) => c.embedding_model)).toEqual([null]);
    const embedder = fakeEmbedder();
    await search(env, "tmember", "test", {}, embedder);
    expect(jobs.sent.map((j) => j.data)).toEqual([{ orgId: env.org.orgId, backfill: true }]);
    await drain(env, jobs, embedder);
    expect((await chunkRows(env, doc.id)).map((c) => c.embedding_model)).toEqual([embedder.model]);
    expect(keys(await search(env, "tmember", "test", {}, embedder))).toContain("team/thanh-toan/kiem-thu");
  });
});
