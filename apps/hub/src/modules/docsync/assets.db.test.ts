import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import type { Auth } from "../identity/index.ts";
import { saveDoc } from "../knowledge/index.ts";
import { createPool, type Jobs, NotFoundError, parseMasterKey, withTenant } from "../platform/index.ts";
import { createMemoryProvider } from "../scm/index.ts";
import {
  type AssetDeps,
  assetFileName,
  findDocAsset,
  handleAssetDownload,
  handleAssetUpload,
  linkHrefs,
  listBrokenLinks,
  listDocAssets,
  relativeFrom,
  resolveDocLinks,
} from "./assets.ts";
import { configureProjectHome } from "./homes.ts";
import { DOCSYNC_PUSH_QUEUE } from "./jobs.ts";

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
// Phiên đăng nhập giả: header riêng của test thay cookie của better-auth.
const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get("x-test-user");
      return id ? { user: { id } } : null;
    },
  },
} as unknown as Auth;
const limits = { assetMaxBytes: 1024, importMaxBytes: 8192, orgStorageBytes: 1024 ** 2 };
const deps = { pool, jobs, masterKey, providerFactory: () => mem, publicUrl: "https://hive.example", auth, limits };

let org: Awaited<ReturnType<typeof seedOrg>>;
let project: Awaited<ReturnType<typeof seedProject>>;
let homeId: string;
const key = `da${tag}`;
const docs = { guide: `project/${key}/huong-dan`, other: `project/${key}/khac`, shared: `project/${key}/chung` };
const user = (name: string) => ({ kind: "user" as const, userId: org.user(name) });
const as = <T>(name: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(pool, { userId: org.user(name), orgId: org.orgId }, fn);

const PNG = (extra = 16) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(extra)]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>';

function upload(who: string | null, docKey: string, file: File, over: Partial<AssetDeps> = {}) {
  const form = new FormData();
  form.set("docKey", docKey);
  form.set("file", file);
  const headers = new Headers({ "x-hive-org": org.orgId });
  if (who) headers.set("x-test-user", org.user(who));
  return handleAssetUpload(
    { ...deps, ...over },
    new Request("http://hub/api/v1/docs/assets", { method: "POST", headers, body: form }),
  );
}

function download(who: string, id: string, query: Record<string, string> = {}, over: Partial<AssetDeps> = {}) {
  const params = new URLSearchParams({ org: org.orgId, ...query });
  return handleAssetDownload(
    { ...deps, ...over },
    new Request(`http://hub/api/v1/docs/assets/${id}?${params}`, { headers: { "x-test-user": org.user(who) } }),
    id,
  );
}

async function uploaded(who: string, docKey: string, file: File) {
  const response = await upload(who, docKey, file);
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return (await response.json()) as { assetId: string; relativePath: string };
}

beforeAll(async () => {
  org = await seedOrg(admin, `da-${tag}`);
  project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key,
  });
  mem.seedRepo(
    { owner: project.owner, name: project.repo },
    { files: { "docs/a.md": "# A\n", ".gitattributes": "*.pdf filter=lfs diff=lfs merge=lfs -text\n" } },
  );
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
  await as("tadmin", async (tx) => {
    await saveDoc(tx, user("tadmin"), {
      key: docs.guide,
      title: "Hướng dẫn",
      content: "# Hướng dẫn\n",
      baseVersion: 0,
    });
    await saveDoc(tx, user("tadmin"), { key: docs.other, title: "Khác", content: "# Khác\n", baseVersion: 0 });
  });
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe("tên file và đường dẫn", () => {
  it("bỏ dấu, giữ đuôi; ảnh dán đặt tên theo giờ", () => {
    expect(assetFileName("Sơ đồ Thanh toán.PNG", "image/png")).toBe("so-do-thanh-toan.png");
    expect(assetFileName("image.png", "image/png", new Date("2026-10-16T08:09:10Z"))).toBe("image-20261016-080910.png");
    expect(relativeFrom("docs/huong-dan.md", "docs/assets/a.png")).toBe("assets/a.png");
    expect(relativeFrom("docs/api/v1.md", "docs/assets/a.png")).toBe("../assets/a.png");
  });

  it("lấy href từ markdown, định nghĩa tham chiếu và HTML", () => {
    expect(linkHrefs('![a](assets/a.png "t") [b](<c d.md>)\n[r]: ref.md\n<img src="x.svg"> [w](https://x.y)')).toEqual(
      expect.arrayContaining(["assets/a.png", "c d.md", "ref.md", "x.svg", "https://x.y"]),
    );
  });
});

describe("tải lên", () => {
  it("thành viên đội tải ảnh: lưu pending_push, xếp lô đẩy, trả đường dẫn tương đối", async () => {
    queued.length = 0;
    const body = await uploaded("tmember", docs.guide, new File([PNG()], "Sơ đồ.png", { type: "image/png" }));
    expect(body.relativePath).toBe("assets/so-do.png");
    const { rows } = await admin.query(
      "select repo_path, state, lfs, owner_doc_id from hive.doc_assets where id = $1",
      [body.assetId],
    );
    expect(rows[0]).toMatchObject({ repo_path: "docs/assets/so-do.png", state: "pending_push", lfs: false });
    expect(queued).toContainEqual({ queue: DOCSYNC_PUSH_QUEUE, data: { orgId: org.orgId, homeId } });
  });

  it("cùng nội dung thì dùng lại; cùng tên khác nội dung thì thêm hậu tố hash", async () => {
    const first = await uploaded("tmember", docs.guide, new File([PNG()], "Sơ đồ.png", { type: "image/png" }));
    expect(first.relativePath).toBe("assets/so-do.png");
    const second = await uploaded("tmember", docs.guide, new File([PNG(32)], "Sơ đồ.png", { type: "image/png" }));
    expect(second.relativePath).toMatch(/^assets\/so-do-[0-9a-f]{8}\.png$/);
  });

  it("chưa đăng nhập 401; chỉ xem 403; không đọc được tài liệu 404", async () => {
    const file = () => new File([PNG()], "a.png", { type: "image/png" });
    expect((await upload(null, docs.guide, file())).status).toBe(401);
    expect((await upload("tviewer", docs.guide, file())).status).toBe(403);
    expect((await upload("oadmin", docs.guide, file())).status).toBe(404);
    expect((await upload("loner", docs.guide, file())).status).toBe(404);
  });

  it("nội dung không khớp đuôi file thì từ chối", async () => {
    const response = await upload("tmember", docs.guide, new File(["không phải ảnh"], "a.png", { type: "image/png" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ data: { code: "BLOB_TYPE_MISMATCH" } });
  });

  it("file thường vượt trần thì DOCSYNC_ASSET_TOO_LARGE kèm gợi ý bật LFS", async () => {
    const response = await upload("tmember", docs.guide, new File([PNG(2048)], "lon.png", { type: "image/png" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ data: { code: "DOCSYNC_ASSET_TOO_LARGE" } });
    expect(body.message).toContain("Git LFS");
  });

  it("file khớp LFS trong .gitattributes thì nhận tới trần nhập, đánh dấu lfs", async () => {
    const pdf = new Uint8Array([...new TextEncoder().encode("%PDF-1.7\n"), ...new Uint8Array(4000)]);
    const body = await uploaded("tmember", docs.guide, new File([pdf], "Báo cáo.pdf", { type: "application/pdf" }));
    const { rows } = await admin.query("select lfs from hive.doc_assets where id = $1", [body.assetId]);
    expect(rows[0].lfs).toBe(true);
    const home = await admin.query("select lfs_patterns from hive.doc_homes where id = $1", [homeId]);
    expect(home.rows[0].lfs_patterns).toEqual(["**/*.pdf"]);
    const tooBig = new Uint8Array([...new TextEncoder().encode("%PDF-1.7\n"), ...new Uint8Array(9000)]);
    const response = await upload("tmember", docs.guide, new File([tooBig], "to.pdf", { type: "application/pdf" }));
    expect(await response.json()).toMatchObject({ data: { code: "DOCSYNC_ASSET_TOO_LARGE" } });
  });

  it("tổ chức hết dung lượng kho file thì DOCSYNC_ORG_STORAGE_FULL", async () => {
    const response = await upload("tmember", docs.guide, new File([PNG(64)], "day.png", { type: "image/png" }), {
      limits: { ...limits, orgStorageBytes: 10 },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ data: { code: "DOCSYNC_ORG_STORAGE_FULL" } });
  });
});

describe("tải xuống", () => {
  let svgId: string;
  let pngId: string;

  beforeAll(async () => {
    svgId = (await uploaded("tmember", docs.guide, new File([SVG], "so-do.svg", { type: "image/svg+xml" }))).assetId;
    pngId = (await uploaded("tmember", docs.guide, new File([PNG(8)], "anh.png", { type: "image/png" }))).assetId;
  });

  it("SVG có script trả về dạng attachment, kèm CSP chặn script", async () => {
    const response = await download("tviewer", svgId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toMatch(/^private/);
    expect(await response.text()).toBe(SVG);
  });

  it("ảnh thường hiển thị inline, có ETag và trả 304 khi chưa đổi", async () => {
    const response = await download("tmember", pngId);
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG(8));
    const etag = response.headers.get("etag") ?? "";
    const again = await handleAssetDownload(
      deps,
      new Request(`http://hub/api/v1/docs/assets/${pngId}?org=${org.orgId}`, {
        headers: { "x-test-user": org.user("tmember"), "if-none-match": etag },
      }),
      pngId,
    );
    expect(again.status).toBe(304);
  });

  it("file lớn được stream theo nhịp client; hủy giữa chừng thì trả kết nối", async () => {
    const streamed = await download("tmember", pngId, {}, { downloadBufferBytes: 0 });
    expect(new Uint8Array(await streamed.arrayBuffer())).toEqual(PNG(8));
    const cancelled = await download("tmember", pngId, {}, { downloadBufferBytes: 0 });
    await cancelled.body?.cancel();
    expect((await download("tmember", pngId)).status).toBe(200);
  });

  it("người không đọc được tài liệu thì không tải được file", async () => {
    for (const who of ["oadmin", "loner"]) {
      const response = await download(who, svgId, { doc: docs.guide });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ data: { code: "DOCSYNC_ASSET_NOT_FOUND" } });
    }
    expect((await download("oadmin", randomUUID())).status).toBe(404);
    expect((await download("oadmin", "khong-phai-id")).status).toBe(404);
  });

  it("file không có tài liệu chủ chỉ đọc được qua tài liệu có link tới nó", async () => {
    const shared = await admin.query(
      `insert into hive.doc_assets (org_id, home_id, repo_path, blob_id, media_type, size, sha256, lfs, state)
       select org_id, home_id, 'docs/assets/chung.png', blob_id, media_type, size, sha256, false, 'available'
       from hive.doc_assets where id = $1 returning id`,
      [pngId],
    );
    const sharedId = shared.rows[0].id as string;
    await as("tadmin", (tx) =>
      saveDoc(tx, user("tadmin"), { key: docs.shared, content: "![chung](assets/chung.png)\n", baseVersion: 0 }),
    );
    expect((await download("tviewer", sharedId)).status).toBe(404);
    expect((await download("tviewer", sharedId, { doc: docs.other })).status).toBe(404);
    const ok = await download("tviewer", sharedId, { doc: docs.shared });
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG(8));
    expect((await download("oadmin", sharedId, { doc: docs.shared })).status).toBe(404);
    const found = await as("tviewer", (tx) =>
      findDocAsset(tx, user("tviewer"), { docKey: docs.shared, path: "assets/chung.png" }),
    );
    expect(found.id).toBe(sharedId);
    await expect(
      as("oadmin", (tx) => findDocAsset(tx, user("oadmin"), { docKey: docs.shared, path: "assets/chung.png" })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("đính kèm thiếu đối tượng LFS thì báo thiếu, không trả nội dung rỗng", async () => {
    const missing = await admin.query(
      `insert into hive.doc_assets (org_id, home_id, repo_path, media_type, size, sha256, lfs, state, owner_doc_id)
       select org_id, home_id, 'docs/assets/thieu.pdf', 'application/pdf', 10, repeat('a', 64), true, 'missing_lfs',
              owner_doc_id from hive.doc_assets where id = $1 returning id`,
      [pngId],
    );
    const response = await download("tmember", missing.rows[0].id);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: "Thiếu đối tượng LFS." });
  });
});

describe("phân giải link", () => {
  it("link .md thành key, đính kèm thành URL hub, file khác thành URL repo, link hỏng thành missing", async () => {
    const hrefs = [
      "khac.md#muc",
      "chua-co.md",
      "assets/so-do.png",
      "assets/thieu.pdf",
      "../src/main.go?plain=1#L3",
      "../../ngoai.md",
      "https://example.com/a",
      "#muc-1",
    ];
    const links = await as("tmember", (tx) => resolveDocLinks(tx, user("tmember"), { docKey: docs.guide, hrefs }));
    const repo = `https://gitlab.com/${project.owner}/${project.repo}/-/blob/main`;
    expect(links[0]).toEqual({ kind: "doc", href: "khac.md#muc", key: docs.other });
    expect(links[1]).toMatchObject({ kind: "missing", href: "chua-co.md" });
    expect(links[2]).toMatchObject({ kind: "asset", href: "assets/so-do.png" });
    expect(links[2]?.kind === "asset" && links[2].url).toMatch(
      new RegExp(`^/api/v1/docs/assets/${links[2]?.kind === "asset" ? links[2].assetId : ""}\\?org=`),
    );
    expect(links[3]).toMatchObject({ kind: "missing", reason: "Thiếu đối tượng LFS." });
    expect(links[4]).toEqual({ kind: "external", href: hrefs[4], url: `${repo}/src/main.go?plain=1#L3` });
    expect(links[5]).toMatchObject({ kind: "missing", href: "../../ngoai.md" });
    expect(links[6]).toEqual({ kind: "external", href: hrefs[6], url: hrefs[6] });
    expect(links[7]).toEqual({ kind: "doc", href: "#muc-1", key: docs.guide });
  });

  it("người không đọc được tài liệu thì không phân giải được", async () => {
    await expect(
      as("oadmin", (tx) => resolveDocLinks(tx, user("oadmin"), { docKey: docs.guide, hrefs: ["a.md"] })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("liệt kê đính kèm của tài liệu và link gãy của nhà", async () => {
    await as("tadmin", (tx) =>
      saveDoc(tx, user("tadmin"), {
        key: docs.other,
        content: "# Khác\n\n[gãy](khong-co.md) ![ảnh](assets/chung.png)\n",
        baseVersion: 1,
      }),
    );
    const page = await as("tviewer", (tx) =>
      listDocAssets(tx, user("tviewer"), { homeId, docKey: docs.other, limit: 50 }),
    );
    expect(page.items.map((a) => a.repoPath)).toEqual(["docs/assets/chung.png"]);
    const all = await as("tviewer", (tx) => listDocAssets(tx, user("tviewer"), { homeId, limit: 2 }));
    expect(all.items).toHaveLength(2);
    expect(all.nextCursor).toBe(all.items[1]?.id);
    expect(await as("oadmin", (tx) => listDocAssets(tx, user("oadmin"), { homeId, limit: 50 }))).toEqual({
      items: [],
      nextCursor: null,
    });
    const broken = await as("tviewer", (tx) => listBrokenLinks(tx, user("tviewer"), homeId));
    expect(broken).toContainEqual(expect.objectContaining({ docKey: docs.other, href: "khong-co.md" }));
    expect(broken.some((b) => b.href === "assets/chung.png")).toBe(false);
  });
});
