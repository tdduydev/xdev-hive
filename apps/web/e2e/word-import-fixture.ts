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
