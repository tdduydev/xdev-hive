import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, seedOrg } from "../../../../test/org-fixture.ts";
import { seedProject } from "../../../../test/project-fixture.ts";
import type { Auth } from "../../identity/index.ts";
import { saveDoc } from "../../knowledge/index.ts";
import {
  createPool,
  createPostgresBlobStore,
  type Jobs,
  parseMasterKey,
  type Tx,
  withTenant,
} from "../../platform/index.ts";
import { createMemoryProvider } from "../../scm/index.ts";
import { ORG_HEADER } from "../../tenancy/index.ts";
import { configureProjectHome, type HomeRow } from "../homes.ts";
import { DOCSYNC_WORD_IMPORT_QUEUE } from "../queues.ts";
import {
  cancelWordImport,
  getWordImport,
  getWordImportFile,
  listWordImports,
  updateWordImportFile,
} from "../routes/word-imports.ts";
import { docWordImportFiles, docWordImports } from "../schema.ts";
import { handleWordMedia } from "./media.ts";
import { frontMatter } from "./postprocess.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const mem = createMemoryProvider("gitlab", ["xdev-team"]);
const queued: Array<{ queue: string; data: Record<string, unknown> }> = [];
const jobs = {
  enqueue: async (queue: string, data: Record<string, unknown>) => {
    queued.push({ queue, data });
    return randomUUID();
  },
} as unknown as Jobs;
const projectKey = `wp${tag}`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>');

let org: Awaited<ReturnType<typeof seedOrg>>;
let home: HomeRow;
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pool, { userId: org.user(who), orgId: org.orgId }, fn);
const user = (who: string) => ({ kind: "user" as const, userId: org.user(who) });
const key = (name: string) => `project/${projectKey}/srs/${name}`;
const nameOf = (bytes: Uint8Array, ext: string) =>
  `${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.${ext}`;

async function* once(bytes: Uint8Array) {
  yield bytes;
}

interface SeedFile {
  fileName: string;
  state?: string;
  markdown?: string | null;
  images?: Array<{ bytes: Uint8Array; ext: string; mediaType: string }>;
  excluded?: boolean;
  format?: string;
}

/** Lượt tạo trong `docs/srs` của `who`, file đã chuyển như sau job chuyển (T009). */
async function seedImport(who: string, files: SeedFile[], opts: { state?: string; createdAt?: Date } = {}) {
  return withTenant(pool, { orgId: org.orgId }, async (tx) => {
    const store = createPostgresBlobStore();
    const [imp] = await tx
      .insert(docWordImports)
      .values({
        orgId: org.orgId,
        homeId: home.id,
        targetDir: "docs/srs",
        state: opts.state ?? "ready",
        createdBy: org.user(who),
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      })
      .returning();
    if (!imp) throw new Error("không tạo được lượt");
    const ids: string[] = [];
    for (const f of files) {
      const word = await store.put(
        tx,
        org.orgId,
        once(Buffer.from(`word ${randomUUID()}`)),
        "application/octet-stream",
      );
      const images = [];
      for (const image of f.images ?? []) {
        const blob = await store.put(tx, org.orgId, once(image.bytes), image.mediaType);
        images.push({
          name: nameOf(image.bytes, image.ext),
          blobId: blob.id,
          mediaType: blob.mediaType,
          bytes: blob.size,
        });
      }
      const stem = f.fileName.replace(/\.[^.]+$/, "");
      const [file] = await tx
        .insert(docWordImportFiles)
        .values({
          orgId: org.orgId,
          importId: imp.id,
          fileName: f.fileName,
          format: f.format ?? "docx",
          size: 10,
          sha256: "a".repeat(64),
          blobId: word.id,
          proposedPath: `docs/srs/${stem}.md`,
          proposedTitle: stem,
          state: f.state ?? "ready",
          excluded: f.excluded ?? false,
          markdown:
            f.markdown === undefined
              ? `${frontMatter({ title: stem, file: f.fileName, sha256: "a".repeat(64), confidential: false })}# ${stem}\n`
              : f.markdown,
          images,
        })
        .returning();
      if (!file) throw new Error("không tạo được file");
      ids.push(file.id);
    }
    return { importId: imp.id, fileIds: ids };
  });
}

const fakeAuth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get("x-test-user");
      return id ? { user: { id }, session: {} } : null;
    },
  },
} as unknown as Auth;

function media(
  who: string | null,
  importId: string,
  fileId: string,
  name: string,
  headers: Record<string, string> = {},
) {
  const request = new Request(`http://hub.test/api/v1/docs/word-imports/${importId}/files/${fileId}/media/${name}`, {
    headers: { ...(who ? { "x-test-user": org.user(who) } : {}), [ORG_HEADER]: org.orgId, ...headers },
  });
  return handleWordMedia({ pool, auth: fakeAuth }, request, { importId, fileId, name });
}

beforeAll(async () => {
  org = await seedOrg(admin, `dwp-${tag}`);
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  mem.seedRepo({ owner: project.owner, name: project.repo }, { files: { "README.md": "# Repo\n" } });
  home = await as("tadmin", (tx) =>
    configureProjectHome(
      tx,
      { pool, jobs, masterKey, providerFactory: () => mem },
      { userId: org.user("tadmin"), orgId: org.orgId },
      {
        project: projectKey,
        settings: {
          enabled: true,
          root: "docs/",
          repoSync: "direct",
          include: ["**/*.md"],
          exclude: [],
          assetsDir: "assets",
          repoChangesNeedReview: false,
          wordImportConfidential: false,
        },
      },
    ),
  );
  await as("tadmin", (tx) =>
    saveDoc(tx, user("tadmin"), { key: key("existing"), content: "# Có sẵn\n", baseVersion: 0 }),
  );
});

beforeEach(() => {
  queued.length = 0;
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe("xem lượt nhập Word", () => {
  it("người tạo thấy với quyền propose, người manage thấy với quyền manage, người khác 404", async () => {
    const { importId, fileIds } = await seedImport("tmember", [{ fileName: "opd.docx" }]);
    const mine = await as("tmember", (tx) => getWordImport(tx, user("tmember"), importId));
    expect(mine.access).toBe("propose");
    expect(mine.import).toMatchObject({ id: importId, mode: "create", createdBy: { id: org.user("tmember") } });
    expect(mine.files).toEqual([
      expect.objectContaining({
        id: fileIds[0],
        path: "docs/srs/opd.md",
        key: key("opd"),
        exists: false,
        title: "opd",
      }),
    ]);
    expect((await as("tadmin", (tx) => getWordImport(tx, user("tadmin"), importId))).access).toBe("manage");
    for (const other of ["tviewer", "oadmin"])
      expect(await errorCode(() => as(other, (tx) => getWordImport(tx, user(other), importId)))).toBe(
        "WORD_IMPORT_NOT_FOUND",
      );
    expect(
      await errorCode(() => as("tviewer", (tx) => getWordImportFile(tx, user("tviewer"), fileIds[0] as string))),
    ).toBe("WORD_IMPORT_FILE_NOT_FOUND");
  });

  it("file: Markdown và ảnh kèm url xem trước; chưa chuyển thì không có Markdown", async () => {
    const { importId, fileIds } = await seedImport("tmember", [
      { fileName: "anh.docx", images: [{ bytes: PNG, ext: "png", mediaType: "image/png" }] },
      { fileName: "cho.docx", state: "converting", markdown: null },
    ]);
    const [done, waiting] = fileIds as [string, string];
    const detail = await as("tmember", (tx) => getWordImportFile(tx, user("tmember"), done));
    expect(detail.markdown).toContain("# anh");
    expect(detail.current).toBeNull();
    const name = nameOf(PNG, "png");
    expect(detail.images).toEqual([
      {
        name,
        mediaType: "image/png",
        bytes: PNG.byteLength,
        url: expect.stringContaining(`/word-imports/${importId}/files/${done}/media/${name}`),
      },
    ]);
    const pending = await as("tmember", (tx) => getWordImportFile(tx, user("tmember"), waiting));
    expect(pending).toMatchObject({ state: "converting", markdown: null, images: [] });
  });

  it("list: chỉ lượt người gọi thấy, mới nhất trước, phân trang bằng con trỏ", async () => {
    const t0 = Date.now() + 86_400_000;
    const a = await seedImport("tmember", [], { createdAt: new Date(t0) });
    const b = await seedImport("tmember", [], { createdAt: new Date(t0 + 1000) });
    const c = await seedImport("tadmin", [], { createdAt: new Date(t0 + 2000) });
    const list = (who: string, cursor?: string) =>
      as(who, (tx) => listWordImports(tx, user(who), { homeId: home.id, limit: 2, ...(cursor ? { cursor } : {}) }));
    const first = await list("tmember");
    expect(first.items.map((i) => i.id)).toEqual([b.importId, a.importId]);
    expect(first.nextCursor).not.toBeNull();
    const next = await list("tmember", first.nextCursor as string);
    expect(next.items.map((i) => i.id)).not.toContain(c.importId);
    expect(next.items.map((i) => i.id)).not.toContain(b.importId);
    const manager = await list("tadmin");
    expect(manager.items.map((i) => i.id)).toEqual([c.importId, b.importId]);
    expect((await list("tviewer")).items).toEqual([]);
    expect(await errorCode(() => list("tmember", "rác"))).toBe("WORD_IMPORT_INVALID_CURSOR");
  });
});

describe("sửa file trong lượt", () => {
  it("đổi đường dẫn: trùng file khác trong lượt bị chặn, trùng tài liệu có sẵn bị chặn, ngoài nhà bị chặn", async () => {
    const { fileIds } = await seedImport("tmember", [{ fileName: "mot.docx" }, { fileName: "hai.docx" }]);
    const [one, two] = fileIds as [string, string];
    const update = (path: string, fileId = two) =>
      as("tmember", (tx) => updateWordImportFile(tx, jobs, user("tmember"), { fileId, path }));
    expect(await errorCode(() => update("docs/srs/mot.md"))).toBe("WORD_IMPORT_DUPLICATE_PATH");
    expect(await errorCode(() => update("docs/srs/existing.md"))).toBe("WORD_IMPORT_EXISTS");
    expect(await errorCode(() => update("khac/hai.md"))).toBe("WORD_IMPORT_OUTSIDE_HOME");
    const moved = await update("docs/srs/moi/hai.md");
    expect(moved).toMatchObject({ path: "docs/srs/moi/hai.md", key: key("moi/hai"), exists: false });
    // File bị bỏ chọn không giữ đường dẫn: file kia lấy lại được.
    await as("tmember", (tx) => updateWordImportFile(tx, jobs, user("tmember"), { fileId: one, excluded: true }));
    expect(await update("docs/srs/mot.md")).toMatchObject({ path: "docs/srs/mot.md" });
  });

  it("đổi tiêu đề dựng lại front matter của bản xem trước", async () => {
    const { fileIds } = await seedImport("tmember", [{ fileName: "tieude.docx" }]);
    const fileId = fileIds[0] as string;
    const saved = await as("tmember", (tx) =>
      updateWordImportFile(tx, jobs, user("tmember"), { fileId, title: "Đặc tả mới" }),
    );
    expect(saved.title).toBe("Đặc tả mới");
    const detail = await as("tmember", (tx) => getWordImportFile(tx, user("tmember"), fileId));
    expect(detail.markdown).toMatch(/^---\ntitle: "Đặc tả mới"\n/);
    expect(detail.markdown).toContain("---\n\n# tieude\n");
  });

  it("đổi keepFront xếp chuyển lại file đó, lượt quay về converting", async () => {
    const { importId, fileIds } = await seedImport("tmember", [{ fileName: "bia.docx" }]);
    const fileId = fileIds[0] as string;
    const saved = await as("tmember", (tx) =>
      updateWordImportFile(tx, jobs, user("tmember"), { fileId, keepFront: true }),
    );
    expect(saved).toMatchObject({ keepFront: true, state: "queued", stats: null, warnings: [] });
    expect(queued).toEqual([{ queue: DOCSYNC_WORD_IMPORT_QUEUE, data: { orgId: org.orgId, fileId } }]);
    const { rows } = await admin.query("select state, counts from hive.doc_word_imports where id = $1", [importId]);
    expect(rows[0]).toMatchObject({ state: "converting", counts: { queued: 1, ready: 0 } });
    // Giữ nguyên giá trị thì không chuyển lại.
    queued.length = 0;
    await as("tmember", (tx) => updateWordImportFile(tx, jobs, user("tmember"), { fileId, keepFront: true }));
    expect(queued).toEqual([]);
  });

  it("lượt đã huỷ thì không sửa được; người không thấy lượt nhận 404", async () => {
    const { importId, fileIds } = await seedImport("tmember", [{ fileName: "huy.docx" }]);
    const fileId = fileIds[0] as string;
    expect(
      await errorCode(() =>
        as("tviewer", (tx) => updateWordImportFile(tx, jobs, user("tviewer"), { fileId, excluded: true })),
      ),
    ).toBe("WORD_IMPORT_FILE_NOT_FOUND");
    const cancelled = await as("tmember", (tx) => cancelWordImport(tx, user("tmember"), importId));
    expect(cancelled).toMatchObject({ state: "cancelled", counts: { cancelled: 1, ready: 0 } });
    expect(
      await errorCode(() =>
        as("tmember", (tx) => updateWordImportFile(tx, jobs, user("tmember"), { fileId, excluded: true })),
      ),
    ).toBe("WORD_IMPORT_CLOSED");
    // Huỷ lại không lỗi.
    expect((await as("tmember", (tx) => cancelWordImport(tx, user("tmember"), importId))).state).toBe("cancelled");
  });

  it("huỷ: file hỏng giữ trạng thái, lượt đã xong không huỷ được", async () => {
    const { importId, fileIds } = await seedImport("tmember", [
      { fileName: "tot.docx" },
      { fileName: "hong.docx", state: "failed", markdown: null },
    ]);
    await as("tadmin", (tx) => cancelWordImport(tx, user("tadmin"), importId));
    const { rows } = await admin.query("select id, state from hive.doc_word_import_files where import_id = $1", [
      importId,
    ]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.state]))).toEqual({
      [fileIds[0] as string]: "cancelled",
      [fileIds[1] as string]: "failed",
    });
    const done = await seedImport("tmember", [], { state: "done" });
    expect(await errorCode(() => as("tmember", (tx) => cancelWordImport(tx, user("tmember"), done.importId)))).toBe(
      "WORD_IMPORT_CLOSED",
    );
  });
});

describe("ảnh xem trước", () => {
  it("người tạo và người manage xem được; người khác 404; chưa đăng nhập 401", async () => {
    const { importId, fileIds } = await seedImport("tmember", [
      { fileName: "media.docx", images: [{ bytes: PNG, ext: "png", mediaType: "image/png" }] },
    ]);
    const fileId = fileIds[0] as string;
    const name = nameOf(PNG, "png");
    const ok = await media("tmember", importId, fileId, name);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toMatch(/^private/);
    expect(ok.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await media("tadmin", importId, fileId, name)).status).toBe(200);
    expect((await media("tviewer", importId, fileId, name)).status).toBe(404);
    expect((await media("oadmin", importId, fileId, name)).status).toBe(404);
    expect((await media(null, importId, fileId, name)).status).toBe(401);
    expect((await media("tmember", importId, fileId, "000000000000.png")).status).toBe(404);
    const cached = await media("tmember", importId, fileId, name, { "if-none-match": `"${name}"` });
    expect(cached.status).toBe(304);
  });

  it("SVG trả attachment kèm CSP chặn script", async () => {
    const { importId, fileIds } = await seedImport("tmember", [
      { fileName: "svg.docx", images: [{ bytes: SVG, ext: "svg", mediaType: "image/svg+xml" }] },
    ]);
    const name = nameOf(SVG, "svg");
    const res = await media("tmember", importId, fileIds[0] as string, name);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
