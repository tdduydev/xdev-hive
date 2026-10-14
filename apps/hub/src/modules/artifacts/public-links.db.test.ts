import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_AGENT_POLICY, type OrgArtifactPolicy } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { type Reader, readerFor } from "./access.ts";
import { frameRoutes } from "./frame-routes.ts";
import {
  createPublicLink,
  listPublicLinks,
  orgListPublicLinks,
  PublicViewLog,
  resolvePublicLink,
  revokePublicLink,
} from "./public-links.ts";
import { publicRateLimiter } from "./rate-limit.ts";
import { createArtifact, deleteArtifact, restoreArtifact, transferOwner, updateArtifact } from "./service.ts";
import { frameTicketKey } from "./ticket.ts";
import { tombstoneVersion } from "./versions.ts";

/*
 * SC-012 / US13: link công khai qua hàm router dùng và route HTTP thật (Hono + Postgres, RLS, role hive_app). Trang và
 * khung chi tiết hơn (header, CSP, giới hạn tốc độ) ở frame-routes.db.test.ts.
 */

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const tag = randomUUID().slice(0, 6);
const HUB = "https://hub.example.test";
const frameKey = frameTicketKey(parseMasterKey(randomBytes(32).toString("base64")));
const deps = { publicUrl: HUB };
// Bộ giới hạn rộng để các ca ở đây không chạm hạn mức của nhau; ca 429 ở frame-routes.db.test.ts.
const routes = frameRoutes({
  pool: app,
  frameKey,
  publicUrl: HUB,
  rateLimiter: publicRateLimiter({ ipPerMinute: 100_000, linkPerMinute: 100_000 }),
  viewLog: new PublicViewLog(),
});
// Mẫu PAT GitHub giả: đủ dạng để bộ quét bắt, không phải token thật. Khác chuỗi của file test khác vì database dùng chung
// và artifacts.db.test.ts đếm phiên bản chứa chuỗi của nó trên cả bảng.
const FAKE_TOKEN = `ghp_${"Z9y8X7w6".repeat(5)}wxyz`;

type Org = OrgFixture & { user: (n: string) => string };
let org: Org;
let other: Org;

function as<T>(who: string, fn: (tx: Tx, reader: Reader) => Promise<T>, fixture: Org = org): Promise<T> {
  return withTenant(app, { userId: fixture.user(who), orgId: fixture.orgId }, async (tx) =>
    fn(tx, await readerFor(tx, { kind: "user", userId: fixture.user(who) })),
  );
}

async function setPolicy(orgId: string, artifacts: Partial<OrgArtifactPolicy>) {
  await admin.query(
    `insert into hive.agent_policies (org_id, policy) values ($1, $2)
     on conflict (org_id) do update set policy = excluded.policy`,
    [orgId, JSON.stringify({ ...DEFAULT_AGENT_POLICY, artifacts: { scopes: ["private", "team"], ...artifacts } })],
  );
}

/** Artifact phạm vi đội của `tmember`: người trong đội (kể cả quản trị) đọc và sửa được nhưng không phải chủ. */
const seed = async (content = "<h1>Bảng giá</h1>", fixture: Org = org) =>
  (
    await as(
      "tmember",
      (tx, r) =>
        createArtifact(tx, r, { type: "html", title: "Bảng giá", content, scope: "team", teamId: fixture.teamId }),
      fixture,
    )
  ).artifact.id;

const create = (id: string, version = 1, expiresInDays = 7, who = "tmember") =>
  as(who, (tx, r) => createPublicLink(tx, r, { id, version, expiresInDays }, deps));

const tokenOf = (url: string) => {
  expect(url.startsWith(`${HUB}/_artifact/s/`)).toBe(true);
  return url.slice(`${HUB}/_artifact/s/`.length);
};

const page = (token: string) => routes.request(`/_artifact/s/${token}`);

const auditRows = async (orgId: string, action: string) =>
  (
    await admin.query("select data, target_id, actor_user_id from hive.audit_log where org_id = $1 and action = $2", [
      orgId,
      action,
    ])
  ).rows as { data: Record<string, unknown>; target_id: string | null; actor_user_id: string | null }[];

let notFound: { body: string; headers: [string, string][] };

/** 404 của trang công khai: cùng chữ, cùng header cho mọi lý do (FR-142). */
async function expectUniform404(token: string) {
  const res = await page(token);
  expect(res.status).toBe(404);
  expect(await res.text()).toBe(notFound.body);
  expect([...res.headers.entries()].sort()).toEqual(notFound.headers);
}

beforeAll(async () => {
  org = await seedOrg(admin, `pl-${tag}`);
  other = await seedOrg(admin, `pl2-${tag}`);
  await setPolicy(org.orgId, {});
  await setPolicy(other.orgId, {});
  const res = await page(randomBytes(32).toString("base64url"));
  notFound = { body: await res.text(), headers: [...res.headers.entries()].sort() };
  expect(notFound.body).toContain("Liên kết không tồn tại hoặc đã hết hạn.");
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("tạo link", () => {
  it("chủ tạo được; mã 32 byte chỉ có trong URL, database chỉ giữ sha256; audit không có mã", async () => {
    const id = await seed();
    const { link, url } = await create(id, 1, 7);
    const token = tokenOf(url);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(link).toMatchObject({ artifactId: id, version: 1, active: true, viewCount: 0, revokedAt: null });
    const days = (new Date(link.expiresAt).getTime() - new Date(link.createdAt).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 3);

    const stored = await admin.query("select * from hive.artifact_public_links where id = $1", [link.id]);
    expect(stored.rows[0].token_sha256).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(stored.rows[0])).not.toContain(token);

    const created = (await auditRows(org.orgId, "artifact.public_link.create")).filter((a) => a.target_id === id);
    expect(created).toHaveLength(1);
    expect(created[0]?.data).toMatchObject({ linkId: link.id, version: 1, expiresInDays: 7 });
    expect(created[0]?.actor_user_id).toBe(org.user("tmember"));
    const everything = await admin.query("select data::text as d from hive.audit_log where org_id = $1", [org.orgId]);
    for (const row of everything.rows) expect(row.d).not.toContain(token);

    // Link mở được ngay.
    expect((await page(token)).status).toBe(200);
  });

  it("chỉ chủ: quản trị đội, quản trị tổ chức, người cùng đội → ARTIFACT_LINK_OWNER_ONLY; ngoài phạm vi → NOT_FOUND", async () => {
    const id = await seed();
    for (const who of ["tadmin", "admin", "owner", "tviewer"])
      expect(await errorCode(() => create(id, 1, 7, who))).toBe("ARTIFACT_LINK_OWNER_ONLY");
    expect(await errorCode(() => create(id, 1, 7, "loner"))).toBe("ARTIFACT_NOT_FOUND");
    expect(
      await errorCode(() =>
        as("owner", (tx, r) => createPublicLink(tx, r, { id, version: 1, expiresInDays: 7 }, deps), other),
      ),
    ).toBe("ARTIFACT_NOT_FOUND");
  });

  it("hạn vượt chính sách, phiên bản không có, artifact trong thùng rác", async () => {
    const id = await seed();
    await setPolicy(org.orgId, { publicLinks: { enabled: true, maxDays: 3 } });
    try {
      expect(await errorCode(() => create(id, 1, 4))).toBe("ARTIFACT_LINK_EXPIRY_INVALID");
      expect((await create(id, 1, 3)).link.active).toBe(true);
    } finally {
      await setPolicy(org.orgId, {});
    }
    expect(await errorCode(() => create(id, 9))).toBe("ARTIFACT_NOT_FOUND");
    await as("tmember", (tx, r) => deleteArtifact(tx, r, { id }));
    expect(await errorCode(() => create(id))).toBe("ARTIFACT_NOT_FOUND");
  });

  it("tối đa 10 link còn hiệu lực mỗi artifact; thu hồi bớt thì tạo lại được", async () => {
    const id = await seed();
    const links = [];
    for (let i = 0; i < 10; i++) links.push((await create(id)).link);
    expect(await errorCode(() => create(id))).toBe("ARTIFACT_LINK_LIMIT");
    const first = links[0];
    if (!first) throw new Error("thiếu link");
    await as("tmember", (tx, r) => revokePublicLink(tx, r, { linkId: first.id }, deps));
    expect((await create(id)).link.active).toBe(true);
  });

  it("hai lần tạo đồng thời không vượt 10 link", async () => {
    const id = await seed();
    for (let i = 0; i < 9; i++) await create(id);
    const results = await Promise.allSettled([create(id), create(id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const active = await admin.query(
      "select count(*)::int as n from hive.artifact_public_links where artifact_id = $1 and revoked_at is null",
      [id],
    );
    expect(active.rows[0].n).toBe(10);
  });

  it("phiên bản có chuỗi giống bí mật → ARTIFACT_SECRET_FOUND, không tạo link", async () => {
    const id = await seed();
    // Phiên bản chứa bí mật lọt vào trước khi bộ quét có quy tắc này: chèn thẳng như dữ liệu cũ.
    await admin.query(
      `insert into hive.artifact_versions (org_id, artifact_id, version, content, sha256, size_bytes, author_user_id, origin)
       select org_id, id, 2, $2, 'x', 10, owner_user_id, origin from hive.artifacts where id = $1`,
      [id, `<p>${FAKE_TOKEN}</p>`],
    );
    expect(await errorCode(() => create(id, 2))).toBe("ARTIFACT_SECRET_FOUND");
    const n = await admin.query("select count(*)::int as n from hive.artifact_public_links where artifact_id = $1", [
      id,
    ]);
    expect(n.rows[0].n).toBe(0);
  });

  it("chính sách tắt link công khai hoặc tắt artifact: không tạo được", async () => {
    const id = await seed();
    await setPolicy(org.orgId, { publicLinks: { enabled: false, maxDays: 30 } });
    try {
      expect(await errorCode(() => create(id))).toBe("ARTIFACT_PUBLIC_LINKS_DISABLED");
      await setPolicy(org.orgId, { enabled: false });
      expect(await errorCode(() => create(id))).toBe("ARTIFACTS_DISABLED");
    } finally {
      await setPolicy(org.orgId, {});
    }
  });
});

describe("hết hiệu lực → cùng một trang 404", () => {
  it("mã sai dạng, mã không có", async () => {
    await expectUniform404("ngan");
    await expectUniform404(randomBytes(32).toString("base64url"));
    await expectUniform404(`${randomBytes(32).toString("base64url")}x`);
  });

  it("hết hạn", async () => {
    const id = await seed();
    const { link, url } = await create(id);
    await admin.query(
      "update hive.artifact_public_links set created_at = now() - interval '9 days', expires_at = now() - interval '1 second' where id = $1",
      [link.id],
    );
    await expectUniform404(tokenOf(url));
    expect(await resolvePublicLink(app, tokenOf(url))).toBeNull();
  });

  it("chủ thu hồi; quản trị tổ chức thu hồi (chủ được báo); người khác không thu hồi được", async () => {
    const id = await seed();
    const a = await create(id);
    const b = await create(id);
    expect(await errorCode(() => as("tadmin", (tx, r) => revokePublicLink(tx, r, { linkId: a.link.id }, deps)))).toBe(
      "ARTIFACT_FORBIDDEN",
    );
    expect(await errorCode(() => as("loner", (tx, r) => revokePublicLink(tx, r, { linkId: a.link.id }, deps)))).toBe(
      "ARTIFACT_NOT_FOUND",
    );
    expect(
      await errorCode(() => as("owner", (tx, r) => revokePublicLink(tx, r, { linkId: a.link.id }, deps), other)),
    ).toBe("ARTIFACT_NOT_FOUND");

    const revoked = await as("tmember", (tx, r) => revokePublicLink(tx, r, { linkId: a.link.id }, deps));
    expect(revoked).toMatchObject({ active: false, revokeReason: "manual", revokedBy: org.user("tmember") });
    await expectUniform404(tokenOf(a.url));
    // Thu hồi lần nữa không đổi gì.
    const again = await as("tmember", (tx, r) => revokePublicLink(tx, r, { linkId: a.link.id }, deps));
    expect(again.revokedAt).toBe(revoked.revokedAt);

    await as("admin", (tx, r) => revokePublicLink(tx, r, { linkId: b.link.id }, deps));
    await expectUniform404(tokenOf(b.url));
    const inbox = await admin.query(
      "select count(*)::int as n from hive.inbox_items where org_id = $1 and user_id = $2 and event = 'artifact.public_link.revoked'",
      [org.orgId, org.user("tmember")],
    );
    expect(inbox.rows[0].n).toBeGreaterThanOrEqual(1);
    const revokes = (await auditRows(org.orgId, "artifact.public_link.revoke")).filter((r) => r.target_id === id);
    expect(revokes.map((r) => r.actor_user_id).sort()).toEqual([org.user("admin"), org.user("tmember")].sort());
    for (const r of revokes) expect(r.data.reason).toBe("manual");
  });

  it("artifact vào thùng rác (khôi phục không mở lại link)", async () => {
    const id = await seed();
    const { url } = await create(id);
    await as("tmember", (tx, r) => deleteArtifact(tx, r, { id }));
    await expectUniform404(tokenOf(url));
    await as("tmember", (tx, r) => restoreArtifact(tx, r, { id }));
    await expectUniform404(tokenOf(url));
  });

  it("chuyển chủ", async () => {
    const id = await seed();
    const { url } = await create(id);
    await as("tmember", (tx, r) => transferOwner(tx, r, { id, userId: org.user("tadmin") }));
    await expectUniform404(tokenOf(url));
  });

  it("phiên bản bị xoá vì bí mật; link của phiên bản khác vẫn chạy", async () => {
    const id = await seed();
    await as("tmember", (tx, r) => updateArtifact(tx, r, { id, baseVersion: 1, content: "<h1>Bản 2</h1>" }));
    const v1 = await create(id, 1);
    const v2 = await create(id, 2);
    await as("tmember", (tx, r) => tombstoneVersion(tx, r, { id, version: 1 }, {}));
    await expectUniform404(tokenOf(v1.url));
    expect((await page(tokenOf(v2.url))).status).toBe(200);
  });

  it("chủ rời tổ chức: link tắt ngay, trước cả job dọn", async () => {
    const id = await seed();
    const { url } = await create(id);
    await admin.query("update hive.org_members set status = 'blocked' where org_id = $1 and user_id = $2", [
      org.orgId,
      org.user("tmember"),
    ]);
    try {
      await expectUniform404(tokenOf(url));
    } finally {
      await admin.query("update hive.org_members set status = 'active' where org_id = $1 and user_id = $2", [
        org.orgId,
        org.user("tmember"),
      ]);
    }
    expect((await page(tokenOf(url))).status).toBe(200);
  });

  it("tắt chính sách link công khai hay tắt artifact: 404, bật lại thì link chạy lại", async () => {
    const id = await seed();
    const { url } = await create(id);
    await setPolicy(org.orgId, { publicLinks: { enabled: false, maxDays: 30 } });
    try {
      await expectUniform404(tokenOf(url));
      await setPolicy(org.orgId, { enabled: false });
      await expectUniform404(tokenOf(url));
    } finally {
      await setPolicy(org.orgId, {});
    }
    expect((await page(tokenOf(url))).status).toBe(200);
  });
});

describe("liệt kê", () => {
  it("chủ thấy mọi link của artifact (kể cả đã thu hồi), không có mã; người khác không", async () => {
    const id = await seed();
    const a = await create(id, 1, 2);
    const b = await create(id, 1, 5);
    await as("tmember", (tx, r) => revokePublicLink(tx, r, { linkId: a.link.id }, deps));
    const list = await as("tmember", (tx, r) => listPublicLinks(tx, r, { id }));
    expect(list.map((l) => [l.id, l.active])).toEqual([
      [b.link.id, true],
      [a.link.id, false],
    ]);
    expect(JSON.stringify(list)).not.toContain(tokenOf(b.url));
    // Quản trị tổ chức thu hồi được nên cũng xem được.
    expect((await as("admin", (tx, r) => listPublicLinks(tx, r, { id }))).length).toBe(2);
    expect(await errorCode(() => as("tadmin", (tx, r) => listPublicLinks(tx, r, { id })))).toBe(
      "ARTIFACT_LINK_OWNER_ONLY",
    );
    expect(await errorCode(() => as("loner", (tx, r) => listPublicLinks(tx, r, { id })))).toBe("ARTIFACT_NOT_FOUND");
  });

  it("orgList: chỉ quản trị tổ chức, chỉ link còn hiệu lực, kể cả artifact private; phân trang", async () => {
    const shared = await seed();
    const priv = (
      await as("tmember", (tx, r) => createArtifact(tx, r, { type: "html", title: "Riêng", content: "<p>riêng</p>" }))
    ).artifact.id;
    const live = await create(priv);
    const dead = await create(shared);
    await as("tmember", (tx, r) => revokePublicLink(tx, r, { linkId: dead.link.id }, deps));

    expect(
      await errorCode(() => as("tmember", (tx) => orgListPublicLinks(tx, org.user("tmember"), { limit: 50 }))),
    ).toBe("ORG_ROLE_REQUIRED");
    const all = [];
    let cursor: string | undefined;
    do {
      const pageOf = await as("admin", (tx) =>
        orgListPublicLinks(tx, org.user("admin"), { limit: 2, ...(cursor ? { cursor } : {}) }),
      );
      all.push(...pageOf.items);
      cursor = pageOf.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(all.map((l) => l.id)).size).toBe(all.length);
    expect(all.every((l) => l.active)).toBe(true);
    expect(all.some((l) => l.id === dead.link.id)).toBe(false);
    const mine = all.find((l) => l.id === live.link.id);
    expect(mine).toMatchObject({
      artifactTitle: "Riêng",
      artifactType: "html",
      owner: { id: org.user("tmember"), name: org.user("tmember") },
    });
    // Tổ chức khác không thấy.
    const theirs = await as("owner", (tx) => orgListPublicLinks(tx, other.user("owner"), { limit: 100 }), other);
    expect(theirs.items.some((l) => l.id === live.link.id)).toBe(false);
  });
});

describe("lượt xem", () => {
  it("khung có vé `s` tăng view_count; audit gộp một dòng mỗi link mỗi giờ, IP băm, không có mã", async () => {
    const viewLog = new PublicViewLog();
    const local = frameRoutes({
      pool: app,
      frameKey,
      publicUrl: HUB,
      rateLimiter: publicRateLimiter({ ipPerMinute: 1000, linkPerMinute: 1000 }),
      viewLog,
      remoteAddress: () => "198.51.100.23",
    });
    const id = await seed();
    const { link, url } = await create(id);
    const token = tokenOf(url);
    for (let i = 0; i < 3; i++) {
      const html = await (await local.request(`/_artifact/s/${token}`)).text();
      const frame = /src="([^"]+)"/.exec(html)?.[1]?.replaceAll("&amp;", "&");
      if (!frame) throw new Error("trang không có khung");
      expect((await local.request(new URL(frame).pathname)).status).toBe(200);
    }
    const row = await admin.query("select view_count, last_viewed_at from hive.artifact_public_links where id = $1", [
      link.id,
    ]);
    expect(Number(row.rows[0].view_count)).toBe(3);
    expect(row.rows[0].last_viewed_at).not.toBeNull();

    // Giờ hiện tại chưa qua nên chưa ghi; ghi cả thì đúng một dòng.
    expect(await viewLog.flush(app)).toBe(0);
    expect(await viewLog.flush(app, { all: true })).toBe(1);
    const views = (await auditRows(org.orgId, "artifact.public_link.view")).filter((a) => a.data.linkId === link.id);
    expect(views).toHaveLength(1);
    expect(views[0]?.data).toMatchObject({ version: 1, views: 3, visitors: 1 });
    expect(views[0]?.actor_user_id).toBeNull();
    const text = JSON.stringify(views[0]?.data);
    expect(text).not.toContain("198.51.100.23");
    expect(text).not.toContain(token);
  });
});
