import type { Page } from "@playwright/test";
import { type DocHome, docTreeItem } from "@xdev-hive/contracts";
import { docsyncDocsScenario } from "./docsync-docs-fixture.ts";
import {
  DOC_HOME_ID,
  DOC_ORG_HOME_ID,
  type DocsyncFixtureHandler,
  docsyncSettingsFixture,
} from "./docsync-settings-fixture.ts";

// Fixture tự chứa như các docsync-*-fixture: fake-hub nạp file này, nên không import ngược fake-hub.
const ok = (value: unknown) => ({ status: 200, json: { json: value } });

export const WORD_IMPORT_ID = "20202020-0000-4000-8000-0000000000b1";
export const WORD_IMPORT_UPLOAD_URL = "**/api/v1/docs/word-imports";

/** Một lần web gọi `POST /api/v1/docs/word-imports`, đã tách multipart. */
export interface WordUploadCall {
  org: string | undefined;
  /** Trường chữ, giữ thứ tự; trường lặp (relativePaths, lastModified) thành nhiều phần tử. */
  fields: Record<string, string[]>;
  files: { name: string; size: number }[];
}

/** Tách body multipart đủ dùng cho test: trường chữ và tên, cỡ file. Không dùng cho file lớn. */
export function parseMultipart(contentType: string, body: Buffer): Pick<WordUploadCall, "fields" | "files"> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const marker = `--${boundary?.[1] ?? boundary?.[2] ?? ""}`;
  const fields: Record<string, string[]> = {};
  const files: WordUploadCall["files"] = [];
  for (const part of body.toString("latin1").split(marker).slice(1)) {
    if (part.startsWith("--")) break;
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const head = part.slice(0, split);
    const value = part.slice(split + 4, part.length - 2);
    const name = /name="([^"]*)"/.exec(head)?.[1];
    if (name === undefined) continue;
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename !== undefined)
      files.push({ name: Buffer.from(filename, "latin1").toString("utf8"), size: value.length });
    else {
      const list = fields[name] ?? [];
      list.push(Buffer.from(value, "latin1").toString("utf8"));
      fields[name] = list;
    }
  }
  return { fields, files };
}

export interface WordImportOptions {
  /** `/api/v1/health`: mặc định hub có pandoc và LibreOffice. */
  health?: { wordImport?: boolean; wordImportDoc?: boolean };
  /** Mặc định của ô "Tài liệu mật" ở kho tổ chức (kho dự án luôn tắt). */
  orgConfidential?: boolean;
  /** Trả lỗi cho lần tải lên thay vì importId. */
  fail?: { status: number; body: unknown };
  /** Giữ phản hồi tới khi test gọi `release()`, để thử huỷ giữa chừng. */
  hold?: boolean;
}

/**
 * Hub giả cho hộp thoại "Nhập Word": nhà tổ chức (gốc repo, mặc định mật) và nhà dự án payment-api (docs/), cây tài liệu
 * của trang Tài liệu, health, và route tải lên ghi lại mọi lần gọi. Gọi `install(page)` sau `inOrg`: route đăng ký sau
 * thắng route của fake-hub.
 */
export function wordImportScenario(options: WordImportOptions = {}) {
  const settings = docsyncSettingsFixture();
  const docs = docsyncDocsScenario();
  const projectHome = settings.state.home as DocHome;
  const orgHome: DocHome = {
    ...projectHome,
    id: DOC_ORG_HOME_ID,
    scope: "org",
    projectId: null,
    root: "",
    wordImportConfidential: options.orgConfidential ?? true,
  };
  const state = {
    uploads: [] as WordUploadCall[],
    healthCalls: 0,
    release: () => {},
  };
  const held = options.hold ? new Promise<void>((resolve) => (state.release = resolve)) : null;
  // Cây có thêm thư mục con để thử gợi ý thư mục đích.
  const tree = [
    ...docs.state.items,
    ...["docs/srs/OPD/a.md", "docs/srs/IPD/b.md"].map((path, i) =>
      docTreeItem.parse({
        homeId: DOC_HOME_ID,
        path,
        key: `org/srs-${i}`,
        title: `SRS ${i}`,
        kind: "doc",
        state: "synced",
        prNumber: null,
        prUrl: null,
        repoUrl: null,
        repoCommit: "a".repeat(40),
        docId: `22222222-0000-4000-8000-00000000011${i}`,
        assetId: null,
        version: 1,
        error: null,
        scope: { level: "org", teamId: null, projectId: null },
      }),
    ),
  ];
  // Kho tổ chức nằm sẵn trong fixture cài đặt để `docHomes/status`, `configureOrg` cùng nhìn một bản.
  settings.state.orgHome = orgHome;
  const rpc: Record<string, DocsyncFixtureHandler> = {
    ...docs.rpc,
    ...settings.rpc,
    "docHomes/get": (input) =>
      ok((input as { project?: unknown })?.project ? settings.state.home : settings.state.orgHome),
    "docTree/list": () => ok({ items: tree, nextCursor: null }),
  };
  const install = async (page: Page) => {
    await page.route("**/api/v1/health", (route) => {
      state.healthCalls += 1;
      return route.fulfill({
        status: 200,
        json: {
          status: "ok",
          version: "0.2.23",
          time: "2026-10-19T03:00:00.000Z",
          wordImport: true,
          wordImportDoc: true,
          ...options.health,
        },
      });
    });
    await page.route(WORD_IMPORT_UPLOAD_URL, async (route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.fallback();
      const body = request.postDataBuffer();
      state.uploads.push({
        org: request.headers()["x-hive-org"],
        ...parseMultipart(request.headers()["content-type"] ?? "", body ?? Buffer.alloc(0)),
      });
      if (held) await held;
      const reply = options.fail ?? { status: 200, body: { importId: WORD_IMPORT_ID } };
      // Test có thể đã huỷ XHR trong lúc giữ: fulfill lúc đó ném lỗi, không phải lỗi của test.
      await route.fulfill({ status: reply.status, json: reply.body }).catch(() => {});
    });
  };
  return { state, rpc, install, settings, projectHome, orgHome };
}

/** Lỗi như hub trả cho route multipart: lỗi oRPC đã khai báo, mã nghiệp vụ trong `data.code`. */
export const wordImportFailure = (code: string, status = 400) => ({
  status,
  body: { defined: true, code: status === 409 ? "CONFLICT" : "BAD_REQUEST", status, message: "x", data: { code } },
});

// ---- Trang lượt nhập (T011) ----

const AT = "2026-10-19T03:00:00.000Z";
const fileId = (n: number) => `20202020-0000-4000-8000-0000000000c${n}`;
const DOC_ID = "20202020-0000-4000-8000-0000000000e1";
export const WORD_CONFLICT_ID = "20202020-0000-4000-8000-0000000000a1";
const MEDIA_NAME = "9f2c4b7a1d3e.png";
/** PNG 1×1 để ảnh xem trước và ảnh trong editor có thật mà không cần file ngoài. */
export const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
export const WORD_IMAGE_URL = "/e2e/word-pixel.png";

const ERROR_CODES: Record<number, string> = { 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT" };
const err = (status: number, data: unknown) => ({
  status,
  json: {
    json: {
      defined: true,
      code: ERROR_CODES[status] ?? "BAD_REQUEST",
      status,
      message: "x",
      data,
    },
  },
});

export interface WordImportPageOptions extends WordImportOptions {
  mode?: "create" | "link" | "update";
  /** Cập nhật: bản Word mới hợp sạch, chồng nhau, hay trùng lần nhập trước. */
  outcome?: "clean" | "overlap" | "unchanged";
  access?: "manage" | "propose";
  /** File thứ ba bị chặn vì dấu hiệu bí mật. */
  secret?: boolean;
  /** File đầu có đường dẫn đã có tài liệu. */
  exists?: boolean;
  /** Số lần `get` đầu còn trả "đang chuyển", để thử vòng hỏi lại. */
  slowGets?: number;
  /** Lần tạo làm file thứ hai lỗi, các file khác vẫn tạo được. */
  failOnCommit?: boolean;
  /** Gắn: bản chuyển có khớp nội dung hiện tại không. */
  linkMatches?: boolean;
}

const SAMPLES = [
  { name: "SRS-OPD v1.0.docx", path: "docs/srs/OPD/srs-opd.md", title: "SRS OPD", version: "1.0" },
  { name: "SRS-IPD v1.1.docx", path: "docs/srs/IPD/srs-ipd.md", title: "SRS IPD", version: "1.1" },
  {
    name: "Quy-trinh-vien-phi.docx",
    path: "docs/srs/quy-trinh-vien-phi.md",
    title: "Quy trình viện phí",
    version: null,
  },
] as const;

const OPD_MARKDOWN = [
  "# SRS OPD",
  "",
  `![Sơ đồ tiếp đón](media/${MEDIA_NAME})`,
  "",
  "| Mã | Yêu cầu |",
  "| --- | --- |",
  "| R-1 | Đăng ký khám |",
  "| R-2 | Thu viện phí |",
  "",
].join("\n");
const CURRENT_MARKDOWN = "# SRS OPD\n\nMô tả cũ.\n\n| Mã | Yêu cầu |\n| --- | --- |\n| R-1 | Đăng ký khám |\n";

/**
 * Hub giả cho trang lượt nhập: ba file mẫu (hoặc một file ở chế độ gắn), `get`/`file`/`update`/`commit`/`cancel`/
 * `confirmLink`/`ofDoc` có trạng thái, editor trả tài liệu có bảng và ảnh, và hai route ảnh. `state.calls` ghi lại các
 * lần ghi để test kiểm đúng input.
 */
export function wordImportPageScenario(options: WordImportPageOptions = {}) {
  const base = wordImportScenario(options);
  const update = options.mode === "update";
  const outcome = options.outcome ?? "clean";
  // Gắn và cập nhật cùng làm việc trên một tài liệu có sẵn.
  const link = options.mode === "link" || update;
  let access = options.access ?? "manage";
  const calls = {
    update: [] as unknown[],
    commit: [] as unknown[],
    approve: [] as unknown[],
    cancel: 0,
    confirmLink: 0,
    gets: 0,
  };
  let tick = 0;
  const stamp = () => new Date(Date.parse(AT) + ++tick * 1000).toISOString();

  const makeFile = (i: number): Record<string, unknown> => {
    const sample = SAMPLES[i] as (typeof SAMPLES)[number];
    const blocked = options.secret && i === 2;
    return {
      id: fileId(i + 1),
      importId: WORD_IMPORT_ID,
      relativeDir: "",
      fileName: sample.name,
      format: "docx",
      size: 40_000 + i,
      sha256: String(i + 1).repeat(64),
      versionLabel: sample.version,
      proposedPath: sample.path,
      proposedTitle: sample.title,
      path: sample.path,
      title: sample.title,
      key: null,
      exists: options.exists === true && i === 0,
      keepFront: false,
      excluded: false,
      state: blocked ? "blocked_secret" : "ready",
      stats: { headings: 3, tables: i === 0 ? 1 : 0, images: i === 0 ? 1 : 0 },
      warnings: i === 1 ? [{ code: "nested_table", count: 2, detail: null }] : [],
      findings: blocked ? [{ line: 12, kind: "credential_assignment" }] : [],
      error: null,
      linkMatches: null,
      docId: null,
      docVersion: null,
      proposalId: null,
      createdAt: AT,
      updatedAt: AT,
    };
  };
  const files: Record<string, unknown>[] = link ? [makeFile(0)] : SAMPLES.map((_, i) => makeFile(i));
  if (link) Object.assign(files[0] as object, { path: "docs/srs/OPD/a.md", linkMatches: options.linkMatches ?? false });
  if (update)
    Object.assign(files[0] as object, {
      exists: true,
      key: "org/srs-0",
      docId: DOC_ID,
      state: outcome === "unchanged" ? "skipped" : "ready",
      linkMatches: outcome === "unchanged" ? null : outcome === "clean",
    });
  const meta = { state: update && outcome === "unchanged" ? "done" : "ready" };
  const markdownOf = (file: Record<string, unknown>) => {
    const body = file.fileName === SAMPLES[0].name ? OPD_MARKDOWN : `# ${String(file.title)}\n\nNội dung mẫu.\n`;
    return file.keepFront ? `Trang bìa\n\n${body}` : body;
  };

  const counts = () => {
    const n = (state: string) => files.filter((file) => file.state === state).length;
    return {
      queued: n("queued"),
      converting: n("converting"),
      ready: n("ready"),
      skipped: n("skipped"),
      blockedSecret: n("blocked_secret"),
      failed: n("failed"),
      proposed: n("proposed"),
      cancelled: n("cancelled"),
      done: n("done"),
    };
  };
  const importOf = () => ({
    id: WORD_IMPORT_ID,
    homeId: base.orgHome.id,
    targetDir: link ? null : "docs/srs/",
    mode: update ? "update" : link ? "link" : "create",
    docKey: link ? "org/srs-0" : null,
    confidential: false,
    state: meta.state,
    counts: counts(),
    createdBy: { id: "u1", name: "Quản trị" },
    createdAt: AT,
    updatedAt: AT,
  });
  const snapshot = () => {
    const slow = options.slowGets !== undefined && calls.gets <= options.slowGets;
    const shown = slow ? files.map((file) => ({ ...file, state: calls.gets === 1 ? "queued" : "converting" })) : files;
    return { import: { ...importOf(), ...(slow ? { state: "converting" } : {}) }, files: shown, access };
  };
  const state = { conflictOpen: false };
  const conflictOf = () => ({
    id: WORD_CONFLICT_ID,
    homeId: base.orgHome.id,
    docId: DOC_ID,
    key: "org/srs-0",
    title: "SRS OPD",
    repoPath: "docs/srs/OPD/a.md",
    origin: "word",
    baseVersion: 2,
    hubVersion: 3,
    repoCommit: null,
    state: "open",
    resolution: null,
    resolvedVersion: null,
    createdAt: AT,
    updatedAt: AT,
    baseContent: "# SRS OPD\n\nMô tả gốc.",
    hubContent: "# SRS OPD\n\nMô tả sửa trên hub.",
    repoContent: "# SRS OPD\n\nMô tả sửa trong Word.",
    merge: { content: "# SRS OPD\n\nMô tả sửa trên hub.", conflicts: 1 },
  });
  const find = (input: unknown) => files.find((file) => file.id === (input as { fileId: string }).fileId);

  const rpc: Record<string, DocsyncFixtureHandler> = {
    ...base.rpc,
    "wordImports/get": () => {
      calls.gets += 1;
      return ok(snapshot());
    },
    "wordImports/file": (input) => {
      const file = find(input);
      if (!file) return err(404, undefined);
      const converted = markdownOf(file);
      return ok({
        ...file,
        markdown: converted,
        images:
          file.fileName === SAMPLES[0].name
            ? [
                {
                  name: MEDIA_NAME,
                  mediaType: "image/png",
                  bytes: PIXEL_PNG.length,
                  url: `${WORD_IMPORT_UPLOAD_URL.replace("**", "")}/${WORD_IMPORT_ID}/files/${String(file.id)}/media/${MEDIA_NAME}`,
                },
              ]
            : [],
        current: link ? { content: CURRENT_MARKDOWN, version: 2 } : null,
      });
    },
    "wordImports/update": (input) => {
      const i = input as { path?: string; title?: string; keepFront?: boolean; excluded?: boolean };
      calls.update.push(input);
      const file = find(input);
      if (!file) return err(404, undefined);
      if (i.path !== undefined && files.some((other) => other !== file && other.path === i.path))
        return err(409, { code: "WORD_IMPORT_DUPLICATE_PATH" });
      Object.assign(file, {
        ...(i.path !== undefined ? { path: i.path, exists: false } : {}),
        ...(i.title !== undefined ? { title: i.title } : {}),
        ...(i.keepFront !== undefined ? { keepFront: i.keepFront } : {}),
        ...(i.excluded !== undefined ? { excluded: i.excluded } : {}),
        updatedAt: stamp(),
      });
      return ok(file);
    },
    "wordImports/commit": (input) => {
      const i = input as { fileIds?: string[]; acknowledgeSecrets?: boolean };
      calls.commit.push(input);
      if (update) {
        if (access !== "manage") return err(403, { code: "WORD_IMPORT_NEEDS_MANAGE" });
        const file = files[0] as Record<string, unknown>;
        Object.assign(
          file,
          outcome === "clean"
            ? { state: "done", docVersion: 3, linkMatches: true }
            : { state: "done", docVersion: null, linkMatches: false },
          { updatedAt: stamp() },
        );
        meta.state = "done";
        if (outcome === "overlap") state.conflictOpen = true;
        return ok(snapshot());
      }
      const chosen = files.filter((file) =>
        i.fileIds ? i.fileIds.includes(String(file.id)) : file.state === "ready" && file.excluded !== true,
      );
      if (chosen.some((file) => file.exists)) return err(409, { code: "WORD_IMPORT_EXISTS" });
      for (const file of chosen) {
        if (file.state === "blocked_secret" && i.acknowledgeSecrets !== true) continue;
        if (options.failOnCommit && file.id === fileId(2)) {
          Object.assign(file, {
            state: "failed",
            error: { code: "WORD_IMPORT_EXISTS", message: "x" },
            updatedAt: stamp(),
          });
          continue;
        }
        const slug = String(file.path).replace(/^.*\//, "").replace(/\.md$/, "");
        Object.assign(
          file,
          access === "propose"
            ? { state: "proposed", proposalId: "20202020-0000-4000-8000-0000000000d1" }
            : { state: "done", key: `org/${slug}`, docId: "20202020-0000-4000-8000-0000000000e1", docVersion: 1 },
          { updatedAt: stamp() },
        );
      }
      if (!files.some((file) => ["ready", "blocked_secret"].includes(String(file.state)))) meta.state = "done";
      return ok(snapshot());
    },
    "wordImports/cancel": () => {
      calls.cancel += 1;
      meta.state = "cancelled";
      for (const file of files) if (file.state === "ready") Object.assign(file, { state: "cancelled" });
      return ok(importOf());
    },
    "wordImports/confirmLink": (input) => {
      calls.confirmLink += 1;
      const file = find(input);
      if (!file) return err(404, undefined);
      Object.assign(file, { state: "done", updatedAt: stamp() });
      meta.state = "done";
      return ok(file);
    },
    "wordImports/approve": (input) => {
      const i = input as { fileIds: string[] };
      calls.approve.push(input);
      const chosen = files.filter((file) => i.fileIds.includes(String(file.id)));
      if (chosen.length === 0 || chosen.some((file) => file.state !== "proposed"))
        return err(409, { code: "WORD_IMPORT_NOT_PROPOSED" });
      for (const file of chosen) {
        const slug = String(file.path).replace(/^.*\//, "").replace(/\.md$/, "");
        Object.assign(file, { state: "done", key: `org/${slug}`, docId: DOC_ID, docVersion: 1, updatedAt: stamp() });
      }
      return ok(snapshot());
    },
    "wordImports/ofDoc": () => ok(update ? { import: importOf(), file: files[0] } : null),
    "docConflicts/list": () => ok({ items: state.conflictOpen ? [conflictOf()] : [], nextCursor: null }),
    "docConflicts/get": () => ok(conflictOf()),
    "docAssets/resolve": (input) =>
      ok(
        (input as { hrefs: string[] }).hrefs.map((href) => ({
          kind: "asset",
          href,
          assetId: "20202020-0000-4000-8000-0000000000f1",
          url: WORD_IMAGE_URL,
        })),
      ),
    "docEditor/state": (input) => {
      const key = (input as { key: string }).key;
      return ok({
        draft: {
          key,
          title: key.endsWith("srs-opd") ? "SRS OPD" : key,
          content: OPD_MARKDOWN.replace(`media/${MEDIA_NAME}`, MEDIA_NAME),
          scope: { level: "org", teamId: null, projectId: null },
          baseVersion: 1,
          latestVersion: 1,
          revision: 1,
          updatedAt: AT,
          updatedBy: { userId: "u1", runId: null, name: "Quản trị" },
          canEdit: true,
        },
        presence: [],
        workflow: null,
        review: null,
        stage: "drafting",
        draftNumber: 1,
        openComments: 0,
        pendingSuggestions: 0,
      });
    },
    "docEditor/suggestions/list": () => ok([]),
    "docEditor/comments/list": () => ok([]),
    "docEditor/snapshots/list": () => ok([]),
    "docEditor/assist/targets": () => ok([]),
    "docEditor/assist/list": () => ok([]),
  };

  const install = async (page: Page) => {
    await base.install(page);
    const png = (route: import("@playwright/test").Route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: PIXEL_PNG });
    await page.route("**/api/v1/docs/word-imports/*/files/*/media/*", png);
    await page.route(`**${WORD_IMAGE_URL}`, png);
  };
  return {
    ...base,
    rpc,
    install,
    calls,
    files,
    /** Đổi quyền giữa hai lần mở trang: người gửi duyệt xong thì người duyệt vào xem. */
    setAccess: (next: "manage" | "propose") => {
      access = next;
    },
  };
}
