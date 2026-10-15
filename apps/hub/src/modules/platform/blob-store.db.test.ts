import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import JSZip from "jszip";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import {
  BLOB_GC_INTERVAL_MS,
  BLOB_GC_QUEUE,
  blobRefsIn,
  collectBlobs,
  provideBlobRefs,
  queueBlobGc,
  registerBlobGc,
} from "./blob-gc.ts";
import { BLOB_CHUNK_BYTES, createPostgresBlobStore } from "./blob-store.ts";
import { createPool, type Tx, withTenant } from "./db.ts";
import { createJobs, type Jobs } from "./jobs.ts";
import { blobs } from "./schema.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const pool = createPool(db.appUrl);
const limits = { assetMaxBytes: 4 * BLOB_CHUNK_BYTES, importMaxBytes: 2 ** 30, orgStorageBytes: 32 * BLOB_CHUNK_BYTES };
const store = createPostgresBlobStore({ limits });
let orgA: Awaited<ReturnType<typeof seedOrg>>;
let orgB: Awaited<ReturnType<typeof seedOrg>>;
const tenant = <T>(org: typeof orgA, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pool, { orgId: org.orgId, userId: org.user("owner") }, fn);
const source = async function* (bytes: Uint8Array, step = 7331) {
  for (let i = 0; i < bytes.length; i += step) yield bytes.subarray(i, i + step);
};
const read = async (tx: Tx, orgId: string, id: string) => {
  const chunks: Uint8Array[] = [];
  for await (const part of await store.get(tx, orgId, id)) chunks.push(part);
  return Buffer.concat(chunks);
};
const makePng = (length: number) => {
  const bytes = randomBytes(length);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  return bytes;
};
const blobCount = async (tx: Tx) =>
  Number((await tx.execute<{ count: string }>(sql`select count(*) from hive.blobs`)).rows[0]?.count);
const age = async (tx: Tx, ids: string[]) => {
  await tx.execute(
    sql`update hive.blobs set created_at = now() - interval '3 days' where id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`,
  );
};

beforeAll(async () => {
  orgA = await seedOrg(admin, `blob-a-${randomUUID().slice(0, 8)}`);
  orgB = await seedOrg(admin, `blob-b-${randomUUID().slice(0, 8)}`);
});
afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe("kho blob PostgreSQL", () => {
  it("stream chia đúng 512 KiB, hash byte gốc, đọc lại nguyên vẹn và dedupe từng tổ chức", async () => {
    const bytes = makePng(2 * BLOB_CHUNK_BYTES + 37);
    const first = await tenant(orgA, (tx) =>
      store.put(tx, orgA.orgId, source(bytes), "image/png", { filename: "image.png" }),
    );
    expect(first).toMatchObject({
      size: bytes.length,
      chunkCount: 3,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: "image/png",
    });
    await tenant(orgA, async (tx) => {
      expect(await read(tx, orgA.orgId, first.id)).toEqual(bytes);
      expect(await store.stat(tx, orgA.orgId, first.id)).toEqual(first);
      const chunks = await tx.execute<{ ord: number; size: number }>(
        sql`select ord, octet_length(data) as size from hive.blob_chunks where blob_id = ${first.id} order by ord`,
      );
      expect(chunks.rows.map((row) => row.size)).toEqual([BLOB_CHUNK_BYTES, BLOB_CHUNK_BYTES, 37]);
      const before = await blobCount(tx);
      const second = await store.put(tx, orgA.orgId, source(bytes, bytes.length), "image/png");
      expect(second.id).toBe(first.id);
      expect(await blobCount(tx)).toBe(before);
    });
    const other = await tenant(orgB, (tx) => store.put(tx, orgB.orgId, source(bytes), "image/png"));
    expect(other.id).not.toBe(first.id);
    expect(other.sha256).toBe(first.sha256);
    await tenant(orgB, async (tx) => {
      expect(await store.stat(tx, orgA.orgId, first.id)).toBeNull();
      expect(await store.stat(tx, orgB.orgId, first.id)).toBeNull();
      await expect(store.get(tx, orgB.orgId, first.id)).rejects.toMatchObject({ code: "BLOB_NOT_FOUND" });
      expect(await read(tx, orgB.orgId, other.id)).toEqual(bytes);
    });
  });
  it("không cho ghi thiếu tenant hoặc giả orgId", async () => {
    await withTenant(pool, {}, async (tx) => {
      expect(await blobCount(tx)).toBe(0);
      await expect(
        store.put(tx, orgA.orgId, source(Buffer.alloc(0)), "application/octet-stream"),
      ).rejects.toMatchObject({ code: "BLOB_TENANT_REQUIRED" });
    });
    await tenant(orgA, (tx) =>
      expect(store.put(tx, orgB.orgId, source(Buffer.alloc(0)), "application/octet-stream")).rejects.toMatchObject({
        code: "BLOB_TENANT_REQUIRED",
      }),
    );
  });
  it("file rỗng không cần đoạn và đọc được", async () => {
    await tenant(orgA, async (tx) => {
      const empty = await store.put(tx, orgA.orgId, source(Buffer.alloc(0)), "application/octet-stream");
      expect(empty).toMatchObject({ size: 0, chunkCount: 0 });
      expect(await read(tx, orgA.orgId, empty.id)).toEqual(Buffer.alloc(0));
    });
  });
  it("nhận OOXML bằng central directory khi archive lớn hơn một đoạn", async () => {
    const bytes = await new JSZip()
      .file("padding.bin", randomBytes(BLOB_CHUNK_BYTES + 100))
      .file("[Content_Types].xml", "<Types/>")
      .file("word/document.xml", "<document/>")
      .generateAsync({ type: "uint8array", compression: "STORE" });
    await tenant(orgA, async (tx) => {
      const saved = await store.put(
        tx,
        orgA.orgId,
        source(bytes),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        { filename: "file.docx" },
      );
      expect(saved.chunkCount).toBe(2);
      expect(await read(tx, orgA.orgId, saved.id)).toEqual(Buffer.from(bytes));
    });
  });
  it("vượt trần, MIME sai và stream lỗi đều xoá phần ghi dở dù bên gọi bắt lỗi", async () => {
    await tenant(orgA, async (tx) => {
      const before = await blobCount(tx);
      const chunkBefore = (await tx.execute(sql`select count(*) from hive.blob_chunks`)).rows[0];
      const bytes = makePng(BLOB_CHUNK_BYTES + 100);
      await expect(
        store.put(tx, orgA.orgId, source(bytes), "image/png", { maxBytes: BLOB_CHUNK_BYTES + 99 }),
      ).rejects.toMatchObject({ code: "BLOB_TOO_LARGE" });
      await expect(
        store.put(tx, orgA.orgId, source(bytes), "application/pdf", { filename: "file.pdf" }),
      ).rejects.toMatchObject({ code: "BLOB_TYPE_MISMATCH" });
      const broken = async function* () {
        yield bytes;
        throw new Error("Nguồn tải bị ngắt.");
      };
      await expect(store.put(tx, orgA.orgId, broken(), "image/png")).rejects.toThrow("Nguồn tải bị ngắt.");
      expect(await blobCount(tx)).toBe(before);
      expect((await tx.execute(sql`select count(*) from hive.blob_chunks`)).rows[0]).toEqual(chunkBefore);
      const saved = await store.put(tx, orgA.orgId, source(bytes), "image/png", { maxBytes: bytes.length });
      expect(saved.size).toBe(bytes.length);
    });
  });
  it("hạn mức tính theo blob duy nhất, dedupe vẫn được khi kho đã đầy", async () => {
    const org = await seedOrg(admin, `blob-quota-${randomUUID().slice(0, 8)}`);
    const tiny = createPostgresBlobStore({ limits: { ...limits, orgStorageBytes: 16 } });
    const bytes = makePng(16);
    await tenant(org, async (tx) => {
      const first = await tiny.put(tx, org.orgId, source(bytes), "image/png");
      expect((await tiny.put(tx, org.orgId, source(bytes), "image/png")).id).toBe(first.id);
      await expect(tiny.put(tx, org.orgId, source(makePng(9)), "image/png")).rejects.toMatchObject({
        code: "BLOB_STORAGE_QUOTA",
      });
      expect(await blobCount(tx)).toBe(1);
    });
  });
  it("hai lượt tải đồng thời không vượt hạn mức và hai bản giống nhau chỉ lưu một lần", async () => {
    const org = await seedOrg(admin, `blob-race-${randomUUID().slice(0, 8)}`);
    const tiny = createPostgresBlobStore({ limits: { ...limits, orgStorageBytes: 16 } });
    const results = await Promise.allSettled(
      [makePng(16), makePng(16)].map((bytes) =>
        tenant(org, (tx) => tiny.put(tx, org.orgId, source(bytes), "image/png")),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const same = makePng(12);
    const saved = await Promise.all(
      [0, 1].map(() => tenant(orgB, (tx) => store.put(tx, orgB.orgId, source(same), "image/png"))),
    );
    expect(saved[0]?.id).toBe(saved[1]?.id);
  });
  it("transaction ngoài rollback thì metadata và mọi đoạn cũng mất", async () => {
    let id = "";
    await expect(
      tenant(orgA, async (tx) => {
        id = (await store.put(tx, orgA.orgId, source(makePng(100)), "image/png")).id;
        throw new Error("Huỷ lô nhập.");
      }),
    ).rejects.toThrow("Huỷ lô nhập.");
    expect(await tenant(orgA, (tx) => store.stat(tx, orgA.orgId, id))).toBeNull();
  });
});

describe("dọn blob không còn tham chiếu", () => {
  it("đọc và ghi được văn bản theo MIME khi bên gọi không có tên file", async () => {
    await tenant(orgA, async (tx) => {
      const bytes = Buffer.from("Nội dung dùng chung cho artifact.");
      const saved = await store.put(tx, orgA.orgId, source(bytes), "text/markdown; charset=utf-8");
      expect(saved.mediaType).toBe("text/markdown");
      expect(await read(tx, orgA.orgId, saved.id)).toEqual(bytes);
    });
  });
  it("không có nhà cung cấp tham chiếu thì không xoá", async () => {
    expect(await tenant(orgA, (tx) => collectBlobs(tx, orgA.orgId, new Date(Date.now() + 1000)))).toBe(0);
  });
  it("giữ file được dùng bởi mọi module và file mới; xoá cả chunk, không chạm tổ chức khác", async () => {
    const org = await seedOrg(admin, `blob-gc-${randomUUID().slice(0, 8)}`);
    const items = await tenant(org, async (tx) => {
      const result = [];
      for (let i = 0; i < 4; i++) result.push(await store.put(tx, org.orgId, source(makePng(12 + i)), "image/png"));
      await age(
        tx,
        result.slice(0, 3).map((row) => row.id),
      );
      return result;
    });
    const [doc, artifact, orphan, recent] = items;
    if (!doc || !artifact || !orphan || !recent) throw new Error("Thiếu fixture blob.");
    await tenant(org, async (tx) => {
      const connection = randomUUID(),
        home = randomUUID(),
        artifactId = randomUUID();
      await tx.execute(
        sql`insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values (${connection}, ${org.orgId}, 'github', 'blob-test', 'fixture', ${org.user("owner")})`,
      );
      await tx.execute(
        sql`insert into hive.doc_homes (id, org_id, scope, connection_id, owner, name, branch, configured_by) values (${home}, ${org.orgId}, 'org', ${connection}, 'org', 'docs', 'main', ${org.user("owner")})`,
      );
      await tx.execute(
        sql`insert into hive.doc_assets (org_id, home_id, repo_path, blob_id, media_type, size, sha256) values (${org.orgId}, ${home}, 'assets/image.png', ${doc.id}, 'image/png', ${doc.size}, ${doc.sha256})`,
      );
      await tx.execute(
        sql`insert into hive.artifacts (id, org_id, owner_user_id, title, type, origin) values (${artifactId}, ${org.orgId}, ${org.user("owner")}, 'Ảnh', 'image', 'manual')`,
      );
      await tx.execute(
        sql`insert into hive.artifact_versions (org_id, artifact_id, version, blob_id, sha256, size_bytes, author_user_id, origin) values (${org.orgId}, ${artifactId}, 1, ${artifact.id}, ${artifact.sha256}, ${artifact.size}, ${org.user("owner")}, 'manual')`,
      );
    });
    const keepDoc = provideBlobRefs("test-doc", blobRefsIn("doc_assets"));
    const keepArtifact = provideBlobRefs("test-artifact", blobRefsIn("artifact_versions"));
    try {
      expect(await tenant(org, (tx) => collectBlobs(tx, org.orgId))).toBe(1);
      expect(await tenant(org, (tx) => collectBlobs(tx, org.orgId))).toBe(0);
      await tenant(org, async (tx) => {
        expect(await store.stat(tx, org.orgId, doc.id)).not.toBeNull();
        expect(await store.stat(tx, org.orgId, artifact.id)).not.toBeNull();
        expect(await store.stat(tx, org.orgId, recent.id)).not.toBeNull();
        expect(await store.stat(tx, org.orgId, orphan.id)).toBeNull();
        expect((await tx.execute(sql`select 1 from hive.blob_chunks where blob_id = ${orphan.id}`)).rows).toHaveLength(
          0,
        );
      });
      expect(await tenant(orgB, blobCount)).toBeGreaterThan(0);
    } finally {
      keepDoc();
      keepArtifact();
    }
  });
  it("nhà cung cấp lỗi thì không xoá; blobRefsIn đọc tham chiếu thật qua RLS", async () => {
    const saved = await tenant(orgA, (tx) => store.put(tx, orgA.orgId, source(makePng(99)), "image/png"));
    const broken = provideBlobRefs("broken", async () => {
      throw new Error("Không đọc được tham chiếu.");
    });
    try {
      await expect(tenant(orgA, (tx) => collectBlobs(tx, orgA.orgId, new Date(Date.now() + 1000)))).rejects.toThrow(
        "Không đọc được tham chiếu.",
      );
    } finally {
      broken();
    }
    await tenant(orgA, async (tx) => {
      expect(await store.stat(tx, orgA.orgId, saved.id)).not.toBeNull();
      expect(await blobRefsIn("blobs", "id")(tx, [saved.id])).toEqual(new Set([saved.id]));
    });
    expect(await tenant(orgB, (tx) => blobRefsIn("blobs", "id")(tx, [saved.id]))).toEqual(new Set());
  });
  it("dọn qua nhiều lô 200 file", async () => {
    const org = await seedOrg(admin, `blob-pages-${randomUUID().slice(0, 8)}`);
    await tenant(org, (tx) =>
      tx
        .insert(blobs)
        .values(
          Array.from({ length: 201 }, (_, i) => ({
            orgId: org.orgId,
            sha256: createHash("sha256").update(String(i)).digest("hex"),
            size: 0,
            chunkCount: 0,
            mediaType: "application/octet-stream",
            createdAt: new Date(0),
          })),
        )
        .then(() => undefined),
    );
    const provider = vi.fn(async () => new Set<string>());
    const cleanup = provideBlobRefs("pages", provider);
    try {
      expect(await tenant(org, (tx) => collectBlobs(tx, org.orgId))).toBe(201);
      expect(provider.mock.calls).toHaveLength(2);
      expect(await tenant(org, blobCount)).toBe(0);
    } finally {
      cleanup();
    }
  });
  it("không xoá file đang được đọc hoặc sắp được gắn tham chiếu", async () => {
    const org = await seedOrg(admin, `blob-reader-${randomUUID().slice(0, 8)}`);
    const saved = await tenant(org, async (tx) => {
      const saved = await store.put(tx, org.orgId, source(makePng(10)), "image/png");
      await age(tx, [saved.id]);
      return saved;
    });
    let ready!: () => void, release!: () => void;
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader = tenant(org, async (tx) => {
      const ref = await store.stat(tx, org.orgId, saved.id);
      ready();
      await resume;
      expect(ref?.id).toBe(saved.id);
      expect((await read(tx, org.orgId, saved.id)).length).toBe(10);
    });
    const cleanup = provideBlobRefs("reader", async () => new Set());
    try {
      await locked;
      expect(await tenant(org, (tx) => collectBlobs(tx, org.orgId))).toBe(0);
    } finally {
      release();
      await reader;
      cleanup();
    }
    const cleanupAfter = provideBlobRefs("reader", async () => new Set());
    try {
      expect(await tenant(org, (tx) => collectBlobs(tx, org.orgId))).toBe(1);
    } finally {
      cleanupAfter();
    }
  });
  it("mỗi tổ chức chỉ có một job chờ; job chạy lại nối lịch sau 24 giờ", async () => {
    const jobs = createJobs({
      connectionString: db.jobsUrl,
      queues: [{ name: BLOB_GC_QUEUE, policy: "singleton" }],
      maintenance: false,
    });
    await jobs.start();
    try {
      const withJobs = createPostgresBlobStore({ limits, jobs });
      await tenant(orgA, async (tx) => {
        const saved = await withJobs.put(tx, orgA.orgId, source(makePng(24)), "image/png");
        await withJobs.put(tx, orgA.orgId, source(makePng(25)), "image/png");
        const { rows } = await tx.execute<{ count: string }>(
          sql`select count(*) from pgboss.job where name = ${BLOB_GC_QUEUE} and singleton_key = ${orgA.orgId} and state = 'created'`,
        );
        expect(Number(rows[0]?.count)).toBe(1);
        expect(await queueBlobGc(jobs, orgA.orgId, tx)).toBeNull();
        expect(saved.orgId).toBe(orgA.orgId);
      });
      let run: ((job: { data: { orgId: string } }) => Promise<void>) | undefined;
      const workerJobs = {
        ...jobs,
        work: vi.fn(async (_queue, handler) => {
          run = handler;
        }),
      } as Jobs;
      await registerBlobGc(workerJobs, { pool });
      expect(workerJobs.work).toHaveBeenCalledWith(BLOB_GC_QUEUE, expect.any(Function));
      if (!run) throw new Error("Chưa đăng ký job.");
      const started = Date.now();
      await run({ data: { orgId: orgB.orgId } });
      await tenant(orgB, async (tx) => {
        const { rows } = await tx.execute<{ start_after: string }>(
          sql`select extract(epoch from start_after) * 1000 as start_after from pgboss.job where name = ${BLOB_GC_QUEUE} and singleton_key = ${orgB.orgId} and state = 'created'`,
        );
        expect(rows).toHaveLength(1);
        expect(Number(rows[0]?.start_after)).toBeGreaterThanOrEqual(started + BLOB_GC_INTERVAL_MS);
      });
    } finally {
      await jobs.stop();
    }
  });
});
