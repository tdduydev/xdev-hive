import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, withTenant } from "../platform/index.ts";
import { artifactLinks, artifactPreviews, artifactPublicLinks, artifacts, artifactVersions } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const tables = [artifacts, artifactVersions, artifactLinks, artifactPreviews, artifactPublicLinks];
const tableNames = ["artifacts", "artifact_versions", "artifact_links", "artifact_previews", "artifact_public_links"];

type Seed = {
  orgId: string;
  owner: string;
  artifactId: string;
  versionId: string;
  threadId: string;
  messageId: string;
  token: string;
  linkId: string;
};
const seeds: Record<"a" | "b", Seed> = {} as never;
const sha = (token: string) => createHash("sha256").update(token).digest("hex");

/** Superuser seed, bỏ qua RLS: một artifact đủ phiên bản, liên kết, bản xem trước, link công khai và thẻ chat. */
async function seedArtifact(name: string): Promise<Seed> {
  const org = await seedOrg(admin, `art-rls-${name}-${randomUUID().slice(0, 6)}`);
  const owner = org.user("owner");
  const artifactId = (
    await admin.query(
      "insert into hive.artifacts (org_id, owner_user_id, title, type, origin) values ($1, $2, 'Báo cáo', 'html', 'manual') returning id",
      [org.orgId, owner],
    )
  ).rows[0].id as string;
  const versionId = (
    await admin.query(
      "insert into hive.artifact_versions (org_id, artifact_id, version, content, sha256, size_bytes, author_user_id, origin) values ($1, $2, 1, '<p>x</p>', 'abc', 8, $3, 'manual') returning id",
      [org.orgId, artifactId, owner],
    )
  ).rows[0].id as string;
  await admin.query(
    "insert into hive.artifact_links (org_id, artifact_id, target_kind, target_id, created_by_user_id) values ($1, $2, 'run', $3, $4)",
    [org.orgId, artifactId, randomUUID(), owner],
  );
  await admin.query(
    "insert into hive.artifact_previews (org_id, user_id, type, content, expires_at) values ($1, $2, 'html', '<p>x</p>', now() + interval '1 hour')",
    [org.orgId, owner],
  );
  const token = randomUUID();
  const linkId = (
    await admin.query(
      "insert into hive.artifact_public_links (org_id, artifact_id, version, token_sha256, created_by, expires_at) values ($1, $2, 1, $3, $4, now() + interval '7 days') returning id",
      [org.orgId, artifactId, sha(token), owner],
    )
  ).rows[0].id as string;
  const threadId = (
    await admin.query("insert into hive.chat_threads (org_id, created_by, title) values ($1, $2, 't') returning id", [
      org.orgId,
      owner,
    ])
  ).rows[0].id as string;
  const messageId = (
    await admin.query(
      "insert into hive.chat_messages (org_id, thread_id, role, content, artifact_id, artifact_version) values ($1, $2, 'leader', 'Báo cáo', $3, 1) returning id",
      [org.orgId, threadId, artifactId],
    )
  ).rows[0].id as string;
  return { orgId: org.orgId, owner, artifactId, versionId, threadId, messageId, token, linkId };
}

beforeAll(async () => {
  seeds.a = await seedArtifact("a");
  seeds.b = await seedArtifact("b");
});
afterAll(async () => Promise.all([admin.end(), app.end()]));

const asA = (run: Parameters<typeof withTenant>[2]) =>
  withTenant(app, { orgId: seeds.a.orgId, userId: seeds.a.owner }, run);

describe("RLS bảng artifacts", () => {
  it("bật và ép RLS trên mọi bảng", async () => {
    const { rows } = await admin.query(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class where oid = any($1::regclass[]) order by relname",
      [tableNames.map((n) => `hive.${n}`)],
    );
    expect(rows).toHaveLength(tableNames.length);
    for (const row of rows) expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("không có tenant context thì không thấy dòng nào", async () => {
    await withTenant(app, {}, async (tx) => {
      for (const table of tables) expect(await tx.select().from(table)).toHaveLength(0);
    });
  });

  it("chỉ thấy dòng của tổ chức hiện tại, không dòng nào của tổ chức khác", async () => {
    await asA(async (tx) => {
      for (const table of tables) {
        const rows = await tx.select().from(table);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.orgId === seeds.a.orgId)).toBe(true);
      }
      expect(await tx.select().from(artifacts).where(eq(artifacts.id, seeds.b.artifactId))).toEqual([]);
    });
  });

  it("không ghi chéo tổ chức", async () => {
    const base = { orgId: seeds.b.orgId, ownerUserId: "x", title: "t", type: "html", origin: "manual" } as const;
    expect(await pgCode(() => asA((tx) => tx.insert(artifacts).values(base)))).toBe("42501");
    expect(
      await pgCode(() =>
        asA((tx) =>
          tx.insert(artifactVersions).values({
            orgId: seeds.b.orgId,
            artifactId: seeds.b.artifactId,
            version: 2,
            sha256: "x",
            sizeBytes: 1,
            authorUserId: "x",
            origin: "manual",
          }),
        ),
      ),
    ).toBe("42501");
    await asA(async (tx) => {
      expect(
        await tx.update(artifacts).set({ title: "hack" }).where(eq(artifacts.id, seeds.b.artifactId)).returning(),
      ).toEqual([]);
      expect(await tx.delete(artifacts).where(eq(artifacts.id, seeds.b.artifactId)).returning()).toEqual([]);
    });
  });

  it("hive_app không UPDATE hay DELETE được phiên bản", async () => {
    expect(
      await pgCode(() =>
        asA((tx) =>
          tx.update(artifactVersions).set({ content: "đã sửa" }).where(eq(artifactVersions.id, seeds.a.versionId)),
        ),
      ),
    ).toBe("42501");
    expect(
      await pgCode(() => asA((tx) => tx.delete(artifactVersions).where(eq(artifactVersions.id, seeds.a.versionId)))),
    ).toBe("42501");
    const { rows } = await admin.query("select content from hive.artifact_versions where id = $1", [seeds.a.versionId]);
    expect(rows[0].content).toBe("<p>x</p>");
  });

  it("phiên bản phải có đúng một tác giả: người hoặc run", async () => {
    const insert = (authors: { authorUserId?: string; authorRunId?: string }, version: number) =>
      pgCode(() =>
        asA((tx) =>
          tx.insert(artifactVersions).values({
            orgId: seeds.a.orgId,
            artifactId: seeds.a.artifactId,
            version,
            sha256: "x",
            sizeBytes: 1,
            origin: "manual",
            ...authors,
          }),
        ),
      );
    expect(await insert({}, 90)).toBe("23514");
    expect(await insert({ authorUserId: "u", authorRunId: randomUUID() }, 91)).toBe("23514");
    expect(await insert({ authorRunId: randomUUID() }, 92)).toBeUndefined();
  });

  it("phạm vi khớp project_id và team_id", async () => {
    const insert = (values: { scope: "private" | "project" | "team"; projectId?: string; teamId?: string }) =>
      pgCode(() =>
        asA((tx) =>
          tx.insert(artifacts).values({
            orgId: seeds.a.orgId,
            ownerUserId: seeds.a.owner,
            title: "t",
            type: "markdown",
            origin: "manual",
            ...values,
          }),
        ),
      );
    expect(await insert({ scope: "project", teamId: randomUUID() })).toBe("23514");
    expect(await insert({ scope: "private", projectId: randomUUID() })).toBe("23514");
    expect(await insert({ scope: "team" })).toBe("23514");
    expect(await insert({ scope: "private", teamId: randomUUID() })).toBe("23514");
    expect(await insert({ scope: "project", projectId: randomUUID(), teamId: randomUUID() })).toBeUndefined();
  });
});

describe("hive.artifact_tombstone và hive.artifact_version_rename", () => {
  const call = async (org: Seed, fn: "tombstone" | "rename", versionId: string, name?: string) =>
    withTenant(app, { orgId: org.orgId, userId: org.owner }, async (tx) => {
      const query =
        fn === "tombstone"
          ? sql`select hive.artifact_tombstone(${versionId}::uuid) as ok`
          : sql`select hive.artifact_version_rename(${versionId}::uuid, ${name ?? null}) as ok`;
      return (await tx.execute(query)).rows[0]?.ok as boolean;
    });

  it("đổi tên rồi xoá tên một phiên bản của tổ chức mình, từ chối tổ chức khác", async () => {
    expect(await call(seeds.a, "rename", seeds.a.versionId, "  Bản duyệt  ")).toBe(true);
    const row = async () =>
      (await admin.query("select name from hive.artifact_versions where id = $1", [seeds.a.versionId])).rows[0];
    expect(await row()).toEqual({ name: "Bản duyệt" });
    expect(await call(seeds.a, "rename", seeds.a.versionId)).toBe(true);
    expect(await row()).toEqual({ name: null });
    expect(await call(seeds.b, "rename", seeds.a.versionId, "chiếm")).toBe(false);
    expect(await pgCode(() => call(seeds.a, "rename", seeds.a.versionId, "x".repeat(81)))).toBe("23514");
  });

  it("tombstone bỏ nội dung, giữ dòng, ghi người xoá; chạy lại hoặc từ tổ chức khác không làm gì", async () => {
    const other = await seedArtifact("tomb");
    expect(await call(seeds.b, "tombstone", other.versionId)).toBe(false);
    expect(await call(other, "tombstone", other.versionId)).toBe(true);
    const { rows } = await admin.query(
      "select content, compiled, sha256, tombstoned_by, tombstoned_at is not null as gone from hive.artifact_versions where id = $1",
      [other.versionId],
    );
    expect(rows[0]).toEqual({ content: null, compiled: null, sha256: "abc", tombstoned_by: other.owner, gone: true });
    expect(await call(other, "tombstone", other.versionId)).toBe(false);
  });
});

describe("hive.artifact_public_link_resolve", () => {
  const resolve = (token: string) =>
    withTenant(
      app,
      {},
      async (tx) => (await tx.execute(sql`select * from hive.artifact_public_link_resolve(${sha(token)})`)).rows,
    );

  it("trả đúng org_id và link_id, không cột nào khác, không cần tổ chức trong context", async () => {
    const rows = await resolve(seeds.a.token);
    expect(rows).toEqual([{ org_id: seeds.a.orgId, link_id: seeds.a.linkId }]);
  });

  it("không trả link sai mã, hết hạn hoặc đã thu hồi", async () => {
    expect(await resolve(randomUUID())).toEqual([]);
    const expired = randomUUID();
    const revoked = randomUUID();
    for (const [token, extra] of [
      [expired, "created_at = now() - interval '2 days', expires_at = now() - interval '1 day'"],
      [revoked, "revoked_at = now(), revoke_reason = 'manual'"],
    ] as const) {
      await admin.query(
        "insert into hive.artifact_public_links (org_id, artifact_id, version, token_sha256, created_by, expires_at) values ($1, $2, 1, $3, 'u', now() + interval '1 day')",
        [seeds.a.orgId, seeds.a.artifactId, sha(token)],
      );
      await admin.query(`update hive.artifact_public_links set ${extra} where token_sha256 = $1`, [sha(token)]);
      expect(await resolve(token)).toEqual([]);
    }
  });

  it("hive_app không đọc được bảng link của tổ chức khác dù biết băm", async () => {
    await withTenant(app, { orgId: seeds.b.orgId }, async (tx) => {
      const rows = await tx
        .select()
        .from(artifactPublicLinks)
        .where(eq(artifactPublicLinks.tokenSha256, sha(seeds.a.token)));
      expect(rows).toEqual([]);
    });
  });
});

describe("xoá hẳn artifact và hive.artifact_purge", () => {
  it("xoá bằng hive_app kéo theo phiên bản, liên kết, link và đặt artifact_id của thẻ chat về null", async () => {
    const s = await seedArtifact("del");
    await withTenant(app, { orgId: s.orgId, userId: s.owner }, (tx) =>
      tx.delete(artifacts).where(eq(artifacts.id, s.artifactId)),
    );
    for (const table of ["artifact_versions", "artifact_links", "artifact_public_links"]) {
      const { rows } = await admin.query(`select 1 from hive.${table} where artifact_id = $1`, [s.artifactId]);
      expect(rows, table).toHaveLength(0);
    }
    const { rows } = await admin.query(
      "select org_id, artifact_id, artifact_version from hive.chat_messages where id = $1",
      [s.messageId],
    );
    expect(rows[0]).toEqual({ org_id: s.orgId, artifact_id: null, artifact_version: 1 });
  });

  it("purge xoá thùng rác quá 30 ngày, bản xem trước hết hạn và link hết hạn quá 90 ngày, đếm theo tổ chức", async () => {
    const s = await seedArtifact("purge");
    const fresh = (
      await admin.query(
        "insert into hive.artifacts (org_id, owner_user_id, title, type, origin, deleted_at) values ($1, 'u', 'mới xoá', 'html', 'manual', now() - interval '5 days') returning id",
        [s.orgId],
      )
    ).rows[0].id as string;
    await admin.query("update hive.artifacts set deleted_at = now() - interval '31 days' where id = $1", [
      s.artifactId,
    ]);
    await admin.query("update hive.artifact_previews set expires_at = now() - interval '1 minute' where org_id = $1", [
      s.orgId,
    ]);
    const oldLink = randomUUID();
    await admin.query(
      "insert into hive.artifact_public_links (org_id, artifact_id, version, token_sha256, created_by, created_at, expires_at) values ($1, $2, 1, $3, 'u', now() - interval '200 days', now() - interval '100 days')",
      [s.orgId, fresh, sha(oldLink)],
    );

    const rows = await withTenant(
      app,
      {},
      async (tx) => (await tx.execute(sql`select * from hive.artifact_purge()`)).rows,
    );
    expect(rows.find((r) => r.org_id === s.orgId)).toEqual({
      org_id: s.orgId,
      artifacts: 1,
      previews: 1,
      public_links: 1,
    });

    const left = await admin.query("select id from hive.artifacts where org_id = $1", [s.orgId]);
    expect(left.rows.map((r) => r.id)).toEqual([fresh]);
    const { rows: msg } = await admin.query("select artifact_id from hive.chat_messages where id = $1", [s.messageId]);
    expect(msg[0].artifact_id).toBeNull();
    // Hạn truyền vào không rút ngắn được mặc định: thùng rác 5 ngày vẫn còn dù gọi với 0 ngày.
    await withTenant(app, {}, (tx) => tx.execute(sql`select * from hive.artifact_purge(0, 0)`));
    expect((await admin.query("select 1 from hive.artifacts where id = $1", [fresh])).rows).toHaveLength(1);
  });
});

describe("leader chat_messages", () => {
  // Bảng của module leader: truy vấn thô vì module chỉ được import module khác qua index.ts.
  const insertMessage = (artifactId: string, pageErrors: string | null) =>
    asA((tx) =>
      tx.execute(sql`
        insert into hive.chat_messages (org_id, thread_id, role, content, artifact_id, artifact_version, page_errors)
        values (${seeds.a.orgId}, ${seeds.a.threadId}, 'user', 'Sửa giúp', ${artifactId}, 1, ${pageErrors}::jsonb)
        returning page_errors`),
    );

  it("lưu page_errors và thẻ artifact; không trỏ sang artifact của tổ chức khác", async () => {
    const errors = [{ kind: "error", message: "boom" }];
    const result = (await insertMessage(seeds.a.artifactId, JSON.stringify(errors))) as { rows: unknown[] };
    expect(result.rows[0]).toEqual({ page_errors: errors });
    expect(await pgCode(() => insertMessage(seeds.b.artifactId, null))).toBe("23503");
  });
});
