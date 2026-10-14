import { randomBytes, randomUUID } from "node:crypto";
import { buildCsp, LIB_MANIFEST_FILE } from "@xdev-hive/artifacts-runtime";
import { readLibManifest } from "@xdev-hive/artifacts-runtime/node";
import { DEFAULT_AGENT_POLICY } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { type Reader, readerFor } from "./access.ts";
import {
  APP_LIB_BASE,
  createPreview,
  frameDocument,
  frameRoutes,
  frameUrl,
  libManifestLoader,
} from "./frame-routes.ts";
import { createArtifact, deleteArtifact } from "./service.ts";
import { frameTicketKey, signFrameTicket } from "./ticket.ts";
import { tombstoneVersion } from "./versions.ts";

// Route khung qua Hono thật + Postgres thật (RLS, role hive_app). Lớp ghép app.ts (đăng ký trước SPA, phiên thật) ở
// src/artifacts-api.db.test.ts.
const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const frameKey = frameTicketKey(parseMasterKey(randomBytes(32).toString("base64")));
const tag = randomUUID().slice(0, 6);
const HUB = "https://hub.example.test";
const LIB_BASE = `${HUB}/_artifact/lib/`;
// Mẫu PAT GitHub giả: đủ dạng để bộ quét bắt, không phải token thật.
const FAKE_TOKEN = `ghp_${"A1b2C3d4".repeat(5)}abcd`;
const deps = { frameKey, publicUrl: HUB };
const routes = frameRoutes({ pool: app, ...deps });
const manifest = libManifestLoader();

type Org = OrgFixture & { user: (n: string) => string };
let org: Org;
let other: Org;

function as<T>(who: string, fn: (tx: Tx, reader: Reader) => Promise<T>, fixture: Org = org): Promise<T> {
  return withTenant(app, { userId: fixture.user(who), orgId: fixture.orgId }, async (tx) =>
    fn(tx, await readerFor(tx, { kind: "user", userId: fixture.user(who) })),
  );
}

const create = (who: string, type: "html" | "markdown" | "csv", content: string, fixture: Org = org) =>
  as(who, (tx, r) => createArtifact(tx, r, { type, title: "Trang", content }), fixture);

/** Đường dẫn của URL khung để gọi thẳng vào Hono (URL tuyệt đối dựng từ HIVE_PUBLIC_URL). */
function pathOf(url: string): string {
  expect(url.startsWith(`${HUB}/_artifact/frame/`)).toBe(true);
  return new URL(url).pathname;
}

const get = (path: string, headers: Record<string, string> = {}) => routes.request(path, { headers });

beforeAll(async () => {
  org = await seedOrg(admin, `frame-${tag}`);
  other = await seedOrg(admin, `frame2-${tag}`);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("route khung", () => {
  it("vé của người đọc được: 200, CSP chỉ host hub, header FR-071, nội dung trong khung", async () => {
    const created = await create("tmember", "html", "<h1>Xin chào</h1>");
    const { url, expiresAt } = await as("tmember", (tx, r) =>
      frameUrl(tx, r, { id: created.artifact.id, version: 1, theme: "dark" }, deps),
    );
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    const res = await get(pathOf(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(buildCsp({ libBase: LIB_BASE }));
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("sandbox allow-scripts");
    // Mọi nguồn có scheme trong CSP đều là thư mục thư viện trên host của hub.
    for (const source of csp.match(/[a-z][a-z0-9+.-]*:\/\/[^\s;]+/g) ?? []) expect(source).toBe(LIB_BASE);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-site");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await res.text()).toContain("<h1>Xin chào</h1>");
  });

  it("không đọc cookie hay Authorization: có hay không có đều cùng kết quả, vé hỏng vẫn 403", async () => {
    const created = await create("tmember", "html", "<p>cookie</p>");
    const { url } = await as("tmember", (tx, r) =>
      frameUrl(tx, r, { id: created.artifact.id, version: 1, theme: "light" }, deps),
    );
    const creds = { cookie: "better-auth.session_token=abc; hive_org=x", authorization: "Bearer hive_pat_khong_dung" };
    const plain = await get(pathOf(url));
    const withCreds = await get(pathOf(url), creds);
    expect(withCreds.status).toBe(200);
    expect(await withCreds.text()).toBe(await plain.text());
    expect((await get("/_artifact/frame/khong-phai-ve", creds)).status).toBe(403);
  });

  it("người không đọc được artifact không lấy được vé", async () => {
    const created = await create("tmember", "html", "<p>riêng</p>");
    expect(
      await errorCode(() =>
        as("loner", (tx, r) => frameUrl(tx, r, { id: created.artifact.id, version: 1, theme: "light" }, deps)),
      ),
    ).toBe("ARTIFACT_NOT_FOUND");
    expect(
      await errorCode(() =>
        as("owner", (tx, r) => frameUrl(tx, r, { id: created.artifact.id, version: 1, theme: "light" }, deps), other),
      ),
    ).toBe("ARTIFACT_NOT_FOUND");
  });

  it("vé ký cho tổ chức khác với artifact thì 404: RLS theo tổ chức trong vé", async () => {
    const created = await create("tmember", "html", "<p>của org</p>");
    const { ticket } = signFrameTicket(frameKey, { o: other.orgId, a: created.artifact.id, v: 1, t: "light" });
    expect((await get(`/_artifact/frame/${ticket}`)).status).toBe(404);
    const { ticket: right } = signFrameTicket(frameKey, { o: org.orgId, a: created.artifact.id, v: 1, t: "light" });
    expect((await get(`/_artifact/frame/${right}`)).status).toBe(200);
    const { ticket: noVersion } = signFrameTicket(frameKey, { o: org.orgId, a: created.artifact.id, v: 9, t: "light" });
    expect((await get(`/_artifact/frame/${noVersion}`)).status).toBe(404);
  });

  it("vé sửa payload, ký bằng khoá khác hay hết hạn thì 403", async () => {
    const created = await create("tmember", "html", "<p>x</p>");
    const input = { o: org.orgId, a: created.artifact.id, v: 1, t: "light" } as const;
    const { ticket } = signFrameTicket(frameKey, input);
    const [, sig] = ticket.split(".") as [string, string];
    const tampered = Buffer.from(JSON.stringify({ ...input, v: 2, e: Math.floor(Date.now() / 1000) + 60 })).toString(
      "base64url",
    );
    expect((await get(`/_artifact/frame/${tampered}.${sig}`)).status).toBe(403);
    const foreign = signFrameTicket(randomBytes(32), input).ticket;
    expect((await get(`/_artifact/frame/${foreign}`)).status).toBe(403);
    const expired = signFrameTicket(frameKey, input, { now: Date.now() - 301_000 }).ticket;
    const res = await get(`/_artifact/frame/${expired}`);
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("Vé khung");
  });

  it("vé `s` (link công khai) chưa có nhánh kiểm link thì không mở được", async () => {
    const created = await create("tmember", "html", "<p>công khai</p>");
    const { ticket } = signFrameTicket(frameKey, {
      o: org.orgId,
      a: created.artifact.id,
      v: 1,
      s: randomUUID(),
      t: "light",
    });
    expect((await get(`/_artifact/frame/${ticket}`)).status).toBe(404);
  });

  it("artifact trong thùng rác hay phiên bản đã xoá vì bí mật: 410, và không cấp vé mới", async () => {
    const trashed = await create("tmember", "html", "<p>xoá</p>");
    const id = trashed.artifact.id;
    const { url } = await as("tmember", (tx, r) => frameUrl(tx, r, { id, version: 1, theme: "light" }, deps));
    await as("tmember", (tx, r) => deleteArtifact(tx, r, { id }, {}));
    expect((await get(pathOf(url))).status).toBe(410);
    expect(
      await errorCode(() => as("tmember", (tx, r) => frameUrl(tx, r, { id, version: 1, theme: "light" }, deps))),
    ).toBe("ARTIFACT_NOT_FOUND");

    const leaked = await create("tmember", "html", "<p>lộ</p>");
    const lid = leaked.artifact.id;
    const before = await as("tmember", (tx, r) => frameUrl(tx, r, { id: lid, version: 1, theme: "light" }, deps));
    await as("tmember", (tx, r) => tombstoneVersion(tx, r, { id: lid, version: 1 }, {}));
    const gone = await get(pathOf(before.url));
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toContain("lộ</p>");
    expect(
      await errorCode(() =>
        as("tmember", (tx, r) => frameDocument(tx, r, { id: lid, version: 1, theme: "light" }, manifest)),
      ),
    ).toBe("ARTIFACT_NOT_FOUND");
  });

  it("loại không có khung (csv) không cấp vé", async () => {
    await admin.query(
      `insert into hive.agent_policies (org_id, policy) values ($1, $2)
       on conflict (org_id) do update set policy = excluded.policy`,
      [
        org.orgId,
        JSON.stringify({
          ...DEFAULT_AGENT_POLICY,
          artifacts: { types: ["markdown", "code", "html", "mermaid", "react", "csv"] },
        }),
      ],
    );
    const created = await create("tmember", "csv", "a,b\n1,2");
    expect(
      await errorCode(() =>
        as("tmember", (tx, r) => frameUrl(tx, r, { id: created.artifact.id, version: 1, theme: "light" }, deps)),
      ),
    ).toBe("ARTIFACT_TYPE_DISABLED");
    await admin.query("delete from hive.agent_policies where org_id = $1", [org.orgId]);
  });

  it("hub thiếu HIVE_MASTER_KEY: không cấp vé, route khung từ chối mọi vé", async () => {
    const created = await create("tmember", "html", "<p>khoá</p>");
    const noKey = { publicUrl: HUB };
    expect(
      await errorCode(() =>
        as("tmember", (tx, r) => frameUrl(tx, r, { id: created.artifact.id, version: 1, theme: "light" }, noKey)),
      ),
    ).toBe("ARTIFACT_FRAME_UNAVAILABLE");
    const { ticket } = signFrameTicket(frameKey, { o: org.orgId, a: created.artifact.id, v: 1, t: "light" });
    expect((await frameRoutes({ pool: app, ...noKey }).request(`/_artifact/frame/${ticket}`)).status).toBe(403);
  });
});

describe("bản xem trước", () => {
  const previewRows = async (userId: string) =>
    Number(
      (await admin.query("select count(*)::int as n from hive.artifact_previews where user_id = $1", [userId])).rows[0]
        .n,
    );

  it("nội dung chưa lưu mở trong khung với no-store; hết hạn thì 404", async () => {
    const out = await as("tmember", (tx, r) =>
      createPreview(tx, r, { type: "html", content: "<p>nháp</p>", theme: "light" }, deps),
    );
    expect(out.compileError).toBeNull();
    const res = await get(pathOf(out.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-security-policy")).toBe(buildCsp({ libBase: LIB_BASE }));
    expect(await res.text()).toContain("<p>nháp</p>");
    await admin.query("update hive.artifact_previews set expires_at = now() - interval '1 second' where user_id = $1", [
      org.user("tmember"),
    ]);
    expect((await get(pathOf(out.url))).status).toBe(404);
  });

  it("bản xem trước có bí mật bị chặn: không lưu dòng nào, không cấp vé, audit không có chuỗi", async () => {
    const user = org.user("tadmin");
    const err = await as("tadmin", (tx, r) =>
      createPreview(tx, r, { type: "html", content: `<p>ok</p>\n${FAKE_TOKEN}`, theme: "light" }, deps),
    ).catch((e: unknown) => e as { code?: string; detail?: { findings?: { line: number }[] } });
    expect(err).toMatchObject({
      code: "ARTIFACT_SECRET_FOUND",
      detail: { findings: [expect.objectContaining({ line: 2 })] },
    });
    expect(JSON.stringify(err)).not.toContain(FAKE_TOKEN);
    expect(await previewRows(user)).toBe(0);
  });

  it("loại tắt hay không có khung bị từ chối; quá cỡ bị từ chối", async () => {
    for (const type of ["csv", "json"] as const) {
      expect(
        await errorCode(() =>
          as("tmember", (tx, r) => createPreview(tx, r, { type, content: "{}", theme: "light" }, deps)),
        ),
      ).toBe("ARTIFACT_TYPE_DISABLED");
    }
    expect(
      await errorCode(() =>
        as("tmember", (tx, r) =>
          createPreview(tx, r, { type: "html", content: "x".repeat(1024 * 1024 + 1), theme: "light" }, deps),
        ),
      ),
    ).toBe("ARTIFACT_TOO_LARGE");
  });

  it("mỗi người giữ tối đa 20 bản xem trước; bản của người khác không bị đụng", async () => {
    await as("tviewer", (tx, r) => createPreview(tx, r, { type: "html", content: "<p>v</p>", theme: "light" }, deps));
    for (let i = 0; i < 23; i++) {
      await as("owner", (tx, r) => createPreview(tx, r, { type: "markdown", content: `# ${i}`, theme: "dark" }, deps));
    }
    expect(await previewRows(org.user("owner"))).toBe(20);
    expect(await previewRows(org.user("tviewer"))).toBe(1);
  });
});

describe("tài liệu khung cho app", () => {
  it("trỏ thư viện vào giao thức của app, CSP cùng nguồn đó", async () => {
    const created = await create("tmember", "html", "<p>offline</p>");
    const doc = await as("tmember", (tx, r) =>
      frameDocument(tx, r, { id: created.artifact.id, version: 1, theme: "dark" }, manifest),
    );
    expect(doc.csp).toBe(buildCsp({ libBase: APP_LIB_BASE }));
    expect(doc.html).toContain("<p>offline</p>");
    expect(doc.html).not.toContain(HUB);
  });
});

describe("thư viện tĩnh", () => {
  const libs = readLibManifest();

  it("CORS mở, cache immutable, nén một lần", async () => {
    const entry = libs["markdown-it"];
    expect(entry).toBeDefined();
    const res = await get(`/_artifact/lib/${entry?.path}`, { "accept-encoding": "gzip, br" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const raw = await get(`/_artifact/lib/${entry?.path}`);
    expect(raw.headers.get("content-encoding")).toBeNull();
    expect((await raw.arrayBuffer()).byteLength).toBe(entry?.bytes);
    const manifestRes = await get(`/_artifact/lib/${LIB_MANIFEST_FILE}`);
    expect(manifestRes.status).toBe(200);
    expect(await manifestRes.json()).toEqual(libs);
  });

  it("không thoát khỏi thư mục thư viện; đường lạ dưới /_artifact/ là 404, không phải trang web", async () => {
    for (const path of [
      "/_artifact/lib/../package.json",
      "/_artifact/lib/%2e%2e/%2e%2e/package.json",
      "/_artifact/lib/%2e%2e%2f%2e%2e%2fpackage.json",
      "/_artifact/lib/",
      "/_artifact/lib/khong-co.js",
      "/_artifact/lib/%E0%A4%A",
      "/_artifact/khac",
      "/_artifact/frame/",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('"name"');
    }
    expect((await routes.request("/_artifact/frame/x", { method: "POST" })).status).toBe(404);
  });
});
