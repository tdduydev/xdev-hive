import { randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_AGENT_POLICY } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, parseMasterKey, withTenant } from "../platform/index.ts";
import { readerFor } from "./access.ts";
import { frameRoutes } from "./frame-routes.ts";
import { createPublicLink, revokePublicLink } from "./public-links.ts";
import { createArtifact, deleteArtifact } from "./service.ts";
import { frameTicketKey, signFrameTicket } from "./ticket.ts";
import { type ArtifactUploadDeps, handleArtifactUpload } from "./upload.ts";

// Tải ảnh/PDF và route tệp `/_artifact/blob/:ticket` trên Postgres thật (BlobStore thật, RLS, role hive_app).
const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const tag = randomUUID().slice(0, 6);
const HUB = "https://hub.example.test";
const frameKey = frameTicketKey(parseMasterKey(randomBytes(32).toString("base64")));
const routes = frameRoutes({ pool: app, frameKey, publicUrl: HUB });

// Đủ magic bytes để `inspectFileType` nhận; phần thân không cần là ảnh/PDF hợp lệ.
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("png-body")]);
const PNG_2 = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("png-body-2")]);
const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj<<>>endobj\n%%EOF");

type Org = OrgFixture & { user: (n: string) => string };
let org: Org;
let other: Org;

const authFor = (userId: string): ArtifactUploadDeps["auth"] =>
  ({ api: { getSession: async () => ({ user: { id: userId } }) } }) as unknown as ArtifactUploadDeps["auth"];

interface UploadOptions {
  who?: string;
  fixture?: Org;
  fields?: Record<string, string>;
  maxBlobBytes?: number;
  anonymous?: boolean;
}

interface UploadJson {
  artifact: { id: string; type: string; title: string; scope: string };
  version: { version: number; hasBlob: boolean };
  code?: string;
  data: { code?: string };
}

async function upload(file: File, opts: UploadOptions = {}) {
  const fixture = opts.fixture ?? org;
  const form = new FormData();
  form.set("file", file);
  for (const [key, value] of Object.entries(opts.fields ?? {})) form.set(key, value);
  const res = await handleArtifactUpload(
    {
      pool: app,
      auth: opts.anonymous
        ? ({ api: { getSession: async () => null } } as never)
        : authFor(fixture.user(opts.who ?? "tmember")),
      publicUrl: HUB,
      maxBlobBytes: opts.maxBlobBytes,
    },
    new Request(`${HUB}/api/v1/artifacts/upload`, {
      method: "POST",
      headers: { "x-hive-org": fixture.orgId },
      body: form,
    }),
  );
  return { status: res.status, json: (await res.json()) as UploadJson };
}

const png = (name = "so-do.png", bytes: Buffer = PNG) => new File([new Uint8Array(bytes)], name, { type: "image/png" });
const pdf = (name = "hop-dong.pdf") => new File([new Uint8Array(PDF)], name, { type: "application/pdf" });

const as = <T>(who: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

/** URL tệp của vé khung đọc được: dựng vé trực tiếp, giống route khung đã làm khi nhúng. */
const readerTicket = (id: string, version = 1) =>
  signFrameTicket(frameKey, { o: org.orgId, a: id, v: version, t: "light" }).ticket;

beforeAll(async () => {
  org = await seedOrg(admin, `upl-${tag}`);
  other = await seedOrg(admin, `upl2-${tag}`);
  // Ảnh và PDF không nằm trong bộ loại mặc định: quản trị tổ chức bật tay trong chính sách.
  await admin.query(
    `insert into hive.agent_policies (org_id, policy) values ($1, $2)
     on conflict (org_id) do update set policy = excluded.policy`,
    [
      org.orgId,
      JSON.stringify({
        ...DEFAULT_AGENT_POLICY,
        artifacts: { types: ["markdown", "code", "html", "mermaid", "react", "image", "pdf"] },
      }),
    ],
  );
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("tải ảnh và PDF lên", () => {
  it("ảnh PNG thành artifact `image` có tệp; tiêu đề lấy từ tên tệp, không có nội dung chữ", async () => {
    const { status, json } = await upload(png());
    expect(status).toBe(201);
    expect(json.artifact).toMatchObject({ type: "image", title: "so-do", scope: "private" });
    expect(json.version).toMatchObject({ version: 1, hasBlob: true });
    const [row] = (
      await admin.query("select content, blob_id from hive.artifact_versions where artifact_id = $1", [
        json.artifact.id,
      ])
    ).rows;
    expect(row.content).toBeNull();
    expect(row.blob_id).not.toBeNull();
  });

  it("PDF thành artifact `pdf`", async () => {
    const { status, json } = await upload(pdf());
    expect(status).toBe(201);
    expect(json.artifact).toMatchObject({ type: "pdf", title: "hop-dong" });
    expect(json.version.hasBlob).toBe(true);
  });

  it("khai MIME octet-stream thì xét theo đuôi tệp, và magic bytes vẫn là phán quyết cuối", async () => {
    const ok = await upload(new File([new Uint8Array(PNG)], "a.png", { type: "application/octet-stream" }));
    expect(ok.status).toBe(201);
    const fake = await upload(new File([new Uint8Array(PDF)], "a.png", { type: "application/octet-stream" }));
    expect(fake.status).toBe(400);
  });

  it("tệp giả: nội dung không khớp đuôi/MIME bị từ chối, không tạo artifact", async () => {
    const before = (await admin.query("select count(*)::int as n from hive.artifacts where org_id = $1", [org.orgId]))
      .rows[0].n as number;
    const fakePng = await upload(new File(["không phải ảnh"], "gia.png", { type: "image/png" }));
    expect(fakePng.status).toBe(400);
    const pngAsPdf = await upload(new File([new Uint8Array(PNG)], "gia.pdf", { type: "application/pdf" }));
    expect(pngAsPdf.status).toBe(400);
    const after = (await admin.query("select count(*)::int as n from hive.artifacts where org_id = $1", [org.orgId]))
      .rows[0].n as number;
    expect(after).toBe(before);
  });

  it("loại ngoài ảnh/PDF (SVG, zip, html) bị từ chối ngay từ khai báo", async () => {
    for (const file of [
      new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "a.svg", { type: "image/svg+xml" }),
      new File(["PK"], "a.zip", { type: "application/zip" }),
      new File(["<p>x</p>"], "a.html", { type: "text/html" }),
    ]) {
      const { status, json } = await upload(file);
      expect(status).toBe(400);
      expect(json.code).toBe("ARTIFACT_BLOB_TYPE");
    }
  });

  it("quá cỡ: ARTIFACT_TOO_LARGE kèm giới hạn, không tạo artifact", async () => {
    const { status, json } = await upload(png("lon.png", Buffer.concat([PNG, Buffer.alloc(500)])), {
      maxBlobBytes: 100,
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(json.data.code).toBe("ARTIFACT_TOO_LARGE");
    const rows = await admin.query("select 1 from hive.artifacts where org_id = $1 and title = 'lon'", [org.orgId]);
    expect(rows.rowCount).toBe(0);
  });

  it("chưa đăng nhập 401; người ngoài tổ chức bị từ chối; thiếu tệp hay thiếu tổ chức 400", async () => {
    expect((await upload(png(), { anonymous: true })).status).toBe(401);
    // `loner` có trong tổ chức khác chứ không phải tổ chức này: seedOrg dựng người theo hậu tố riêng.
    const outsider = await handleArtifactUpload(
      { pool: app, auth: authFor(other.user("tmember")), publicUrl: HUB },
      new Request(`${HUB}/api/v1/artifacts/upload`, {
        method: "POST",
        headers: { "x-hive-org": org.orgId },
        body: (() => {
          const form = new FormData();
          form.set("file", png());
          return form;
        })(),
      }),
    );
    expect(outsider.status).toBeGreaterThanOrEqual(400);
    expect(outsider.status).not.toBe(201);
    const empty = await handleArtifactUpload(
      { pool: app, auth: authFor(org.user("tmember")), publicUrl: HUB },
      new Request(`${HUB}/api/v1/artifacts/upload`, {
        method: "POST",
        headers: { "x-hive-org": org.orgId },
        body: new FormData(),
      }),
    );
    expect(empty.status).toBe(400);
    const noOrg = await handleArtifactUpload(
      { pool: app, auth: authFor(org.user("tmember")), publicUrl: HUB },
      new Request(`${HUB}/api/v1/artifacts/upload`, { method: "POST", body: new FormData() }),
    );
    expect(noOrg.status).toBe(400);
  });

  it("thay tệp bằng phiên bản mới: cùng loại, baseVersion cũ thì xung đột, phiên bản cũ vẫn còn", async () => {
    const created = await upload(png());
    const id = created.json.artifact.id as string;
    const next = await upload(png("moi.png", PNG_2), { fields: { id, baseVersion: "1", message: "Bản vẽ lại" } });
    expect(next.status).toBe(200);
    expect(next.json.version).toMatchObject({ version: 2, hasBlob: true });
    const stale = await upload(png("cu.png", PNG), { fields: { id, baseVersion: "1" } });
    expect(stale.status).toBe(409);
    expect(stale.json.data.code).toBe("ARTIFACT_VERSION_CONFLICT");
    const rows = await admin.query(
      "select version, blob_id is not null as has_blob from hive.artifact_versions where artifact_id = $1 order by version",
      [id],
    );
    expect(rows.rows).toEqual([
      { version: 1, has_blob: true },
      { version: 2, has_blob: true },
    ]);
    // Ảnh không thay bằng PDF.
    const wrong = await upload(pdf(), { fields: { id } });
    expect(wrong.status).toBe(400);
  });

  it("cùng nội dung tải hai lần dùng chung một blob (dedupe theo sha256 của BlobStore)", async () => {
    const a = await upload(png("trung-1.png"));
    const b = await upload(png("trung-2.png"));
    const rows = await admin.query(
      "select distinct blob_id from hive.artifact_versions where artifact_id = any($1::uuid[])",
      [[a.json.artifact.id, b.json.artifact.id]],
    );
    expect(rows.rowCount).toBe(1);
  });
});

describe("route tệp /_artifact/blob/:ticket", () => {
  it("vé đọc được: đúng byte, đúng loại, CORS và CORP mở cho khung, CSP khoá, nosniff", async () => {
    const { json } = await upload(png());
    const res = await routes.request(`/_artifact/blob/${readerTicket(json.artifact.id)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-length")).toBe(String(PNG.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("PDF trả application/pdf", async () => {
    const { json } = await upload(pdf());
    const res = await routes.request(`/_artifact/blob/${readerTicket(json.artifact.id)}`);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it("khung của artifact ảnh trỏ tệp về route này, CSP mở đúng thư mục tệp", async () => {
    const { json } = await upload(png());
    const res = await routes.request(`/_artifact/frame/${readerTicket(json.artifact.id)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(`img-src data: blob: ${HUB}/_artifact/blob/`);
    expect(await res.text()).toContain(`${HUB}/_artifact/blob/`);
  });

  it("vé hỏng 403 (vẫn có CORS để khung đọc được lỗi); vé tổ chức khác 404; phiên bản không có 404", async () => {
    const { json } = await upload(png());
    const id = json.artifact.id as string;
    const bad = await routes.request("/_artifact/blob/khong-phai-ve");
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBe("*");
    const foreign = signFrameTicket(frameKey, { o: other.orgId, a: id, v: 1, t: "light" }).ticket;
    expect((await routes.request(`/_artifact/blob/${foreign}`)).status).toBe(404);
    expect((await routes.request(`/_artifact/blob/${readerTicket(id, 9)}`)).status).toBe(404);
  });

  it("artifact html (không có tệp) không đọc được qua route tệp", async () => {
    const created = await as("tmember", async (tx) =>
      createArtifact(tx, await readerFor(tx, { kind: "user", userId: org.user("tmember") }), {
        type: "html",
        title: "Trang",
        content: "<p>x</p>",
      }),
    );
    expect((await routes.request(`/_artifact/blob/${readerTicket(created.artifact.id)}`)).status).toBe(404);
  });

  it("artifact vào thùng rác thì 410", async () => {
    const { json } = await upload(png());
    const id = json.artifact.id as string;
    const ticket = readerTicket(id);
    expect((await routes.request(`/_artifact/blob/${ticket}`)).status).toBe(200);
    await as("tmember", async (tx) =>
      deleteArtifact(tx, await readerFor(tx, { kind: "user", userId: org.user("tmember") }), { id }, {}),
    );
    expect((await routes.request(`/_artifact/blob/${ticket}`)).status).toBe(410);
  });

  it("vé của link công khai: mở được, no-store; thu hồi link thì tệp hết đọc ngay", async () => {
    const { json } = await upload(pdf());
    const id = json.artifact.id as string;
    const deps = { frameKey, publicUrl: HUB };
    const link = await as("tmember", async (tx) =>
      createPublicLink(
        tx,
        await readerFor(tx, { kind: "user", userId: org.user("tmember") }),
        { id, version: 1, expiresInDays: 7 },
        deps,
      ),
    );
    const ticket = signFrameTicket(frameKey, { o: org.orgId, a: id, v: 1, s: link.link.id, t: "light" }).ticket;
    const open = await routes.request(`/_artifact/blob/${ticket}`);
    expect(open.status).toBe(200);
    expect(open.headers.get("cache-control")).toBe("private, no-store");
    await as("tmember", async (tx) =>
      revokePublicLink(
        tx,
        await readerFor(tx, { kind: "user", userId: org.user("tmember") }),
        { linkId: link.link.id },
        deps,
      ),
    );
    expect((await routes.request(`/_artifact/blob/${ticket}`)).status).toBe(404);
  });
});
