import { describe, expect, it } from "vitest";
import {
  DOCSYNC_ERRORS,
  docAssetDownloadOutput,
  docAssetUploadOutput,
  docConflictResolveInput,
  docHomeConfigureOrgInput,
  docHomeConfigureProjectInput,
  docHomeGetInput,
  docHomeStatus,
  docImportConfirmSecretInput,
  docImportScanInput,
  docImportStartInput,
  docImportState,
  docResolvedLink,
  docSyncErrorData,
  docSyncState,
  docTreeItem,
  docTreeMoveInput,
} from "./doc-sync.ts";
import { contract } from "./index.ts";
import {
  DOC_MAX_CHARS,
  docAssetGetInput,
  docListInput,
  docSaveInput,
  docSearchInput,
  docSearchMcpInput,
  docSearchOutput,
  docSecretErrorData,
} from "./knowledge.ts";
import { notificationChannelEvent, notificationEvent } from "./notify.ts";
import { docRepoPath } from "./projects.ts";

const id = "00000000-0000-4000-8000-000000000001";
const orgConfig = { connectionId: id, owner: "group/subgroup", name: "org-docs" };

describe("hợp đồng nhà tài liệu", () => {
  it("nhà tổ chức mặc định direct, không đoán nhánh repo, có thể tạo repo", () => {
    expect(docHomeConfigureOrgInput.parse(orgConfig)).toMatchObject({
      create: false,
      mode: "direct",
      root: "",
      assetsDir: "assets",
      repoChangesNeedReview: false,
    });
    expect(docHomeConfigureOrgInput.parse(orgConfig).branch).toBeUndefined();
    expect(
      docHomeConfigureOrgInput.parse({ ...orgConfig, create: true, branch: "docs/main", mode: "pr" }),
    ).toMatchObject({ create: true, branch: "docs/main", mode: "pr" });
    expect(docHomeGetInput.parse({})).toEqual({});
    expect(docHomeGetInput.parse({ project: "hive" })).toEqual({ project: "hive" });
  });

  it("nhà dự án dùng settings docs có mặc định và nhận dự án bằng key hoặc id", () => {
    for (const project of ["hive", id]) {
      expect(docHomeConfigureProjectInput.parse({ project, settings: {} }).settings).toMatchObject({
        enabled: false,
        root: "docs/",
        repoSync: "pr",
        assetsDir: "assets",
      });
    }
    expect(docHomeConfigureProjectInput.safeParse({ settings: {} }).success).toBe(false);
    expect(docHomeConfigureOrgInput.safeParse({ ...orgConfig, mode: "auto" }).success).toBe(false);
  });

  it("giữ tên Unicode và khoảng trắng, từ chối đường dẫn thoát repo", () => {
    for (const path of ["docs/", "Tài liệu/Thiết kế.md", "docs/assets/image.png"]) {
      expect(docRepoPath.parse(path)).toBe(path);
    }
    for (const path of [
      "",
      "/docs",
      "../docs",
      "docs/../file.md",
      "./docs",
      "docs//a",
      "docs\\a",
      "C:/docs",
      "docs/\u0000a",
    ]) {
      expect(docRepoPath.safeParse(path).success, path).toBe(false);
    }
    for (const branch of ["../main", "/main", "a//b", "main.lock", "main ", "a."]) {
      expect(docHomeConfigureOrgInput.safeParse({ ...orgConfig, branch }).success, branch).toBe(false);
    }
  });
});

describe("nhập, xung đột, file và cây", () => {
  it("nhập chỉ chọn file, xác nhận bí mật theo từng đường dẫn", () => {
    expect(docImportScanInput.parse({ homeId: id })).toEqual({ homeId: id });
    expect(docImportStartInput.parse({ importId: id, paths: ["docs/API.md"] }).paths).toEqual(["docs/API.md"]);
    for (const paths of [[], ["../secret.md"], ["docs/"]]) {
      expect(docImportStartInput.safeParse({ importId: id, paths }).success).toBe(false);
    }
    expect(docImportConfirmSecretInput.safeParse({ importId: id }).success).toBe(false);
    expect(docImportConfirmSecretInput.parse({ importId: id, path: "docs/API.md" }).path).toBe("docs/API.md");
  });

  it("trùng key phải chọn key mới hoặc bản dùng để gắn tài liệu hub", () => {
    const input = { importId: id, paths: ["docs/API.md"] };
    const rename = { path: "docs/API.md", action: "rename", key: "org/api-2" };
    expect(docImportStartInput.parse({ ...input, resolutions: [rename] }).resolutions).toEqual([rename]);
    const attach = { path: "docs/API.md", action: "attach", key: "org/api", choice: "repo", baseVersion: 2 };
    expect(docImportStartInput.parse({ ...input, resolutions: [attach] }).resolutions).toEqual([attach]);
    const { choice: _, ...missingChoice } = attach;
    expect(docImportStartInput.safeParse({ ...input, resolutions: [missingChoice] }).success).toBe(false);
    expect(docImportStartInput.safeParse({ ...input, resolutions: [{ ...rename, key: "../escape" }] }).success).toBe(
      false,
    );
  });

  it("sửa tay cần nội dung và phiên bản, chấp nhận xoá hết nội dung", () => {
    const base = { id, baseVersion: 3 };
    for (const choice of ["hub", "repo"] as const)
      expect(docConflictResolveInput.parse({ ...base, choice }).choice).toBe(choice);
    expect(docConflictResolveInput.safeParse({ ...base, choice: "manual" }).success).toBe(false);
    expect(
      docConflictResolveInput.parse({ ...base, choice: "manual", content: "", acknowledgeSecrets: true }),
    ).toMatchObject({ content: "", acknowledgeSecrets: true });
    expect(
      docConflictResolveInput.safeParse({ ...base, choice: "manual", content: "x".repeat(DOC_MAX_CHARS + 1) }).success,
    ).toBe(false);
    expect(docConflictResolveInput.safeParse({ id, choice: "hub", baseVersion: 0 }).success).toBe(false);
  });

  it("di chuyển giữ key, cần phiên bản và đường dẫn file", () => {
    expect(docTreeMoveInput.parse({ key: "project/hive/api", baseVersion: 2, repoPath: "docs/new/API.md" }).key).toBe(
      "project/hive/api",
    );
    expect(docTreeMoveInput.safeParse({ key: "project/hive/api", baseVersion: 2, repoPath: "docs/new/" }).success).toBe(
      false,
    );
  });

  it("cây vẫn trả tài liệu hub chưa có nhà để hiện nhãn và không giấu nội dung cũ", () => {
    expect(
      docTreeItem.parse({
        homeId: null,
        path: null,
        key: "org/old-doc",
        title: "Tài liệu cũ",
        kind: "doc",
        state: null,
        docId: id,
        assetId: null,
        version: 1,
        error: null,
        prNumber: null,
        prUrl: null,
        repoUrl: null,
        repoCommit: null,
        scope: { level: "org", teamId: null, projectId: null },
      }),
    ).toMatchObject({ key: "org/old-doc", homeId: null, path: null, state: null });
    const schema = contract.docTree.list["~orpc"].inputSchema;
    if (!schema) throw new Error("Thiếu schema cây tài liệu.");
    expect(schema.parse({ project: "hive" })).toEqual({ project: "hive", limit: 50 });
  });

  it("khai báo phản hồi Hono mà không trùng route tải file của oRPC", () => {
    expect(docAssetUploadOutput.parse({ assetId: id, relativePath: "assets/image.png" })).toEqual({
      assetId: id,
      relativePath: "assets/image.png",
    });
    expect(docAssetDownloadOutput.parse(new Uint8Array([0, 255]))).toEqual(new Uint8Array([0, 255]));
    expect(Object.keys(contract.docAssets).sort()).toEqual(["list", "resolve"]);
    for (const value of [
      { kind: "doc", href: "./intro.md", key: "org/intro" },
      { kind: "asset", href: "assets/a.png", assetId: id, url: "/api/v1/docs/assets/test" },
      { kind: "external", href: "https://example.com", url: "https://example.com" },
      { kind: "missing", href: "removed.png", reason: "Không tìm thấy file." },
    ])
      expect(docResolvedLink.parse(value)).toEqual(value);
    expect(docAssetGetInput.parse({ docKey: "org/intro", path: "assets/a.png" }).path).toBe("assets/a.png");
  });
});

describe("tìm kiếm và bí mật", () => {
  it("REST và MCP có giới hạn 20, câu tìm không được rỗng", () => {
    expect(docSearchInput.parse({ query: "  thiết kế  ", limit: "20" })).toEqual({ query: "thiết kế", limit: 20 });
    expect(docSearchMcpInput.parse({ query: "thiết kế" }).limit).toBe(10);
    for (const input of [
      { query: " " },
      { query: "a", limit: 21 },
      { query: "a", limit: 0 },
      { query: "a", scope: "private" },
    ]) {
      expect(docSearchInput.safeParse(input).success).toBe(false);
    }
    expect(docSearchOutput.parse({ mode: "keyword", hits: [] })).toEqual({ mode: "keyword", hits: [] });
    expect(docSearchOutput.safeParse({ mode: "vector", hits: [] }).success).toBe(false);
  });

  it("lọc tài liệu lưu trữ nhận boolean và query string, thao tác cần phiên bản đã lưu", () => {
    expect(docListInput.parse({})).toEqual({});
    expect(docListInput.parse({ archived: "true" }).archived).toBe(true);
    expect(docListInput.parse({ archived: "false" }).archived).toBe(false);
    for (const name of ["archive", "restore"] as const) {
      const schema = contract.docs[name]["~orpc"].inputSchema;
      if (!schema) throw new Error("Thiếu schema lưu trữ tài liệu.");
      expect(schema.parse({ key: "org/test", baseVersion: 1 })).toEqual({ key: "org/test", baseVersion: 1 });
      expect(schema.safeParse({ key: "org/test", baseVersion: 0 }).success).toBe(false);
    }
  });

  it("save cũ vẫn hợp lệ, xác nhận bí mật tường minh, lỗi chỉ gồm loại và dòng", () => {
    const save = { key: "org/test", content: "nội dung", baseVersion: 0 };
    expect(docSaveInput.parse(save)).toEqual(save);
    expect(docSaveInput.parse({ ...save, acknowledgeSecrets: true }).acknowledgeSecrets).toBe(true);
    expect(docSaveInput.safeParse({ ...save, acknowledgeSecrets: "true" }).success).toBe(false);
    expect(
      docSecretErrorData.parse({
        code: "DOC_SECRET_FOUND",
        findings: [{ kind: "github_token", line: 4, value: "redacted" }],
      }),
    ).toEqual({ code: "DOC_SECRET_FOUND", findings: [{ kind: "github_token", line: 4 }] });
    expect(
      docSecretErrorData.safeParse({ code: "DOC_SECRET_FOUND", findings: [{ kind: "github_token", line: 0 }] }).success,
    ).toBe(false);
  });
});

describe("đăng ký hợp đồng", () => {
  it("đủ mọi endpoint T003", () => {
    const groups = {
      docHomes: [
        "get",
        "configureProject",
        "configureOrg",
        "remove",
        "pause",
        "resume",
        "acceptBranch",
        "syncNow",
        "adoptPreview",
        "adopt",
        "status",
      ],
      docImports: ["scan", "get", "files", "start", "cancel", "confirmSecret", "list"],
      docConflicts: ["list", "get", "resolve"],
      docAssets: ["resolve", "list"],
      docExtracts: ["list", "get", "update", "approve", "reject", "confirmSecret"],
      docTree: ["list", "move"],
    } as const;
    for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
      expect(Object.keys(contract[group]).sort()).toEqual([...groups[group]].sort());
    }
    for (const name of ["search", "archive", "restore", "save"] as const) expect(contract.docs[name]).toBeDefined();
  });

  it("phân trang nhận query string và giới hạn kích thước", () => {
    const schema = contract.docImports.files["~orpc"].inputSchema;
    if (!schema) throw new Error("Thiếu schema danh sách file nhập.");
    expect(schema.parse({ id, limit: "200", cursor: "next" })).toEqual({ id, limit: 200, cursor: "next" });
    for (const limit of [0, 201, 1.5]) expect(schema.safeParse({ id, limit }).success).toBe(false);
  });

  it("trạng thái và mã lỗi nghiệp vụ ổn định", () => {
    expect(docHomeStatus.options).toEqual(["active", "paused", "error"]);
    expect(docImportState.options).toContain("cancelled");
    for (const state of ["blocked_secret", "deleted_in_repo", "conflict"])
      expect(docSyncState.parse(state)).toBe(state);
    for (const [code, error] of Object.entries(DOCSYNC_ERRORS)) {
      expect(docSyncErrorData.parse({ code })).toEqual({ code });
      expect(error.message.length).toBeGreaterThan(10);
    }
    expect(docSyncErrorData.safeParse({ code: "UNKNOWN" }).success).toBe(false);
  });

  it("sáu thông báo được chọn cho kênh tổ chức", () => {
    for (const event of [
      "docsync.sync_failed",
      "docsync.conflict",
      "docsync.paused",
      "docsync.import_done",
      "docsync.deleted_in_repo",
      "docsync.extract_review",
    ]) {
      expect(notificationEvent.parse(event)).toBe(event);
      expect(notificationChannelEvent.parse(event)).toBe(event);
    }
  });
});
