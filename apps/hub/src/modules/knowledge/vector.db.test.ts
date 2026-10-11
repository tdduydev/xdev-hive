import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { freshDatabase } from "../../../test/seed.ts";
import { bootstrapRoles, createPool, type Jobs, runMigrations, type Tx, withTenant } from "../platform/index.ts";
import type { Principal } from "./access.ts";
import type { Embedder } from "./embedder.ts";
import { EMBED_QUEUE, type EmbedJob, runEmbed, searchMemory, writeMemory } from "./memory.ts";

// pgvector là tuỳ chọn: hub phải chạy đúng cả khi database có và không có extension vector. Mỗi trường hợp dựng một
// database riêng trong cùng container. Image mặc định của test (pgvector/pgvector) có extension; image Postgres
// thường (HIVE_TEST_POSTGRES_IMAGE trỏ tới mirror) thì phần "có pgvector" bị bỏ qua, CI vẫn chạy đủ.

const db = inject("db");
const probe = new pg.Pool({ connectionString: db.adminUrl, max: 1 });
const available =
  ((await probe.query("select 1 from pg_available_extensions where name = 'vector'")).rowCount ?? 0) > 0;
await probe.end();
if (!available) console.warn("Image Postgres của test không có pgvector: bỏ qua phần kiểm tìm theo vector.");

/**
 * Embedder giả: mỗi trục là một chủ đề, văn bản nhắc tới chủ đề thì có thành phần trên trục đó. Đủ để kiểm memory
 * khớp theo nghĩa dù không chung từ nào với câu tìm.
 */
function fakeEmbedder(model = "gia-lap-v1", fail = false): Embedder & { calls: number } {
  const topics = [
    ["postgres", "cơ sở dữ liệu", "database"],
    ["triển khai", "deploy", "release"],
    ["kiểm thử", "test"],
  ];
  return {
    model,
    calls: 0,
    async embed(texts) {
      this.calls += 1;
      if (fail) throw new Error("API embeddings không phản hồi");
      return texts.map((t) => {
        const s = t.toLowerCase();
        return [...topics.map((words) => (words.some((w) => s.includes(w)) ? 1 : 0)), 0.05];
      });
    },
  };
}

function fakeJobs(): Jobs & { sent: Array<{ queue: string; data: unknown; inTx: boolean }> } {
  const sent: Array<{ queue: string; data: unknown; inTx: boolean }> = [];
  return {
    sent,
    start: async () => {},
    stop: async () => {},
    schedule: async () => {},
    work: async () => {},
    async enqueue(queue, data, opts) {
      sent.push({ queue, data, inTx: opts?.tx !== undefined });
      return randomUUID();
    },
  };
}

interface Env {
  admin: pg.Pool;
  app: pg.Pool;
  org: OrgFixture & { user: (n: string) => string };
}

async function setupEnv(pgvector: boolean): Promise<Env & { urls: Awaited<ReturnType<typeof freshDatabase>> }> {
  const urls = await freshDatabase(db, { pgvector });
  const admin = new pg.Pool({ connectionString: urls.adminUrl });
  const app = createPool(urls.appUrl);
  const org = await seedOrg(admin, "vec");
  return { urls, admin, app, org };
}

const member = (env: Env): Principal => ({ kind: "user", userId: env.org.user("tmember") });
const as = <T>(env: Env, fn: (tx: Tx) => Promise<T>) =>
  withTenant(env.app, { userId: env.org.user("tmember"), orgId: env.org.orgId }, fn);
const teamScope = (env: Env) => ({ level: "team" as const, teamId: env.org.teamId });

async function embeddingColumn(admin: pg.Pool): Promise<boolean> {
  const { rowCount } = await admin.query(
    "select 1 from information_schema.columns where table_schema = 'hive' and table_name = 'memories' and column_name = 'embedding'",
  );
  return (rowCount ?? 0) > 0;
}

describe("không có pgvector: chỉ tìm theo từ", () => {
  let env: Awaited<ReturnType<typeof setupEnv>>;
  beforeAll(async () => {
    env = await setupEnv(false);
  });
  afterAll(async () => {
    await Promise.all([env.admin.end(), env.app.end()]);
  });

  it("migration bỏ qua cột embedding", async () => {
    expect((await env.admin.query("select 1 from pg_extension where extname = 'vector'")).rowCount).toBe(0);
    expect(await embeddingColumn(env.admin)).toBe(false);
  });

  it("có embedder vẫn ghi và tìm được; không gửi job, không gọi API", async () => {
    const embedder = fakeEmbedder();
    const jobs = fakeJobs();
    const m = await as(env, (tx) =>
      writeMemory(
        tx,
        member(env),
        { scope: teamScope(env), kind: "decision", content: "Dùng Postgres làm hàng đợi" },
        { embedder, jobs },
      ),
    );
    expect(jobs.sent).toEqual([]);
    const hits = await as(env, (tx) => searchMemory(tx, member(env), { query: "hàng đợi" }, { embedder }));
    expect(hits.map((h) => [h.id, h.matchedBy])).toEqual([[m.id, ["text"]]]);
    expect(embedder.calls).toBe(0);
    expect(await runEmbed({ pool: env.app, embedder }, { orgId: env.org.orgId, memoryId: m.id })).toBe("skipped");
  });
});

describe.runIf(available)("có pgvector: kết hợp full-text và vector", () => {
  let env: Awaited<ReturnType<typeof setupEnv>>;
  const embedder = fakeEmbedder();
  let postgres = "";
  let deploy = "";

  beforeAll(async () => {
    env = await setupEnv(true);
    const jobs = fakeJobs();
    const write = (content: string) =>
      as(env, (tx) =>
        writeMemory(tx, member(env), { scope: teamScope(env), kind: "note", content }, { embedder, jobs }),
      );
    postgres = (await write("Dùng Postgres làm hàng đợi bằng pg-boss")).id;
    deploy = (await write("Triển khai hub bằng Docker Compose, đổi lần lượt hai bản")).id;
    // Job được gửi trong transaction ghi memory; chạy tay thay cho pg-boss.
    expect(jobs.sent).toEqual([
      { queue: EMBED_QUEUE, data: { orgId: env.org.orgId, memoryId: postgres }, inTx: true },
      { queue: EMBED_QUEUE, data: { orgId: env.org.orgId, memoryId: deploy }, inTx: true },
    ]);
    for (const { data } of jobs.sent) {
      expect(await runEmbed({ pool: env.app, embedder }, data as EmbedJob)).toBe("embedded");
    }
  });
  afterAll(async () => {
    await Promise.all([env.admin.end(), env.app.end()]);
  });

  it("migration thêm cột embedding, job ghi vector kèm tên mô hình", async () => {
    expect(await embeddingColumn(env.admin)).toBe(true);
    const { rows } = await env.admin.query(
      "select embedding_model, vector_dims(embedding) as dims from hive.memories where id = $1",
      [postgres],
    );
    expect(rows).toEqual([{ embedding_model: "gia-lap-v1", dims: 4 }]);
    // Chạy lại job (pg-boss giao lại) không gọi API lần nữa.
    const calls = embedder.calls;
    expect(await runEmbed({ pool: env.app, embedder }, { orgId: env.org.orgId, memoryId: postgres })).toBe("skipped");
    expect(embedder.calls).toBe(calls);
  });

  it("tìm theo nghĩa khi không chung từ nào", async () => {
    const hits = await as(env, (tx) => searchMemory(tx, member(env), { query: "cơ sở dữ liệu" }, { embedder }));
    expect(hits[0]).toMatchObject({ id: postgres, matchedBy: ["vector"] });
  });

  it("khớp cả hai nguồn thì xếp trên", async () => {
    const hits = await as(env, (tx) => searchMemory(tx, member(env), { query: "postgres" }, { embedder }));
    expect(hits[0]).toMatchObject({ id: postgres, matchedBy: ["text", "vector"] });
    expect(hits.map((h) => h.id)).toContain(deploy);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it("embedding sẵn (router tính ngoài transaction) được dùng thay vì gọi lại API", async () => {
    const calls = embedder.calls;
    const [queryEmbedding] = await embedder.embed(["triển khai"]);
    const hits = await as(env, (tx) =>
      searchMemory(tx, member(env), { query: "phát hành" }, { embedder, queryEmbedding }),
    );
    expect(hits[0]?.id).toBe(deploy);
    expect(embedder.calls).toBe(calls + 1);
  });

  it("không so vector của mô hình khác", async () => {
    const hits = await as(env, (tx) =>
      searchMemory(tx, member(env), { query: "cơ sở dữ liệu" }, { embedder: fakeEmbedder("mo-hinh-khac") }),
    );
    expect(hits).toEqual([]);
  });

  it("API embeddings lỗi thì vẫn tìm theo từ", async () => {
    const hits = await as(env, (tx) =>
      searchMemory(tx, member(env), { query: "hàng đợi" }, { embedder: fakeEmbedder("gia-lap-v1", true) }),
    );
    expect(hits.map((h) => [h.id, h.matchedBy])).toEqual([[postgres, ["text"]]]);
  });
});

describe.runIf(available)("cài pgvector sau lần migrate đầu", () => {
  it("chạy lại bootstrap và migrate thì có cột embedding", async () => {
    const urls = await freshDatabase(db, { pgvector: false });
    const admin = new pg.Pool({ connectionString: urls.adminUrl, max: 1 });
    try {
      expect(await embeddingColumn(admin)).toBe(false);
      const pw = (url: string) => decodeURIComponent(new URL(url).password);
      await bootstrapRoles(urls.adminUrl, { owner: pw(urls.ownerUrl), app: pw(urls.appUrl), auth: pw(urls.authUrl) });
      await runMigrations(urls.ownerUrl);
      expect(await embeddingColumn(admin)).toBe(true);
    } finally {
      await admin.end();
    }
  });
});
