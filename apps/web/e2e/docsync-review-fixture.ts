import {
  type DocConflictDetail,
  type DocConflictResolveInput,
  type DocExtract,
  docConflictDetail,
  docConflictResolveInput,
  docExtract,
  docExtractSummary,
  docExtractUpdateInput,
} from "@xdev-hive/contracts";
import type { DocsyncFixtureHandler } from "./docsync-settings-fixture.ts";

export const CONFLICT_ID = "23232323-0000-4000-8000-000000000001";
export const EXTRACT_ID = "23232323-0000-4000-8000-000000000002";
export const PDF_EXTRACT_ID = "23232323-0000-4000-8000-000000000003";
const HOME_ID = "23232323-0000-4000-8000-000000000004";
const NOW = "2026-10-15T03:00:00.000Z";
const ok = (value: unknown) => ({ status: 200, json: { json: value } });
const fail = (code: string, status: number, message: string, data?: unknown) => ({
  status,
  json: { json: { defined: true, code, status, message, data } },
});

export function docsyncReviewScenario(
  options: {
    conflictStale?: boolean;
    extractStale?: boolean;
    secret?: boolean;
    secretOnApprove?: boolean;
    empty?: boolean;
    forbidden?: boolean;
    failed?: boolean;
    pages?: boolean;
  } = {},
) {
  const conflict: DocConflictDetail = docConflictDetail.parse({
    id: CONFLICT_ID,
    homeId: HOME_ID,
    docId: "23232323-0000-4000-8000-000000000005",
    key: "project/payment-api/guide",
    title: "Hướng dẫn thanh toán",
    repoPath: "docs/guide.md",
    baseVersion: 1,
    hubVersion: 2,
    repoCommit: "a".repeat(40),
    state: "open",
    resolution: null,
    resolvedVersion: null,
    createdAt: NOW,
    updatedAt: NOW,
    baseContent: "# Hướng dẫn\n\nNội dung gốc.",
    hubContent: "# Hướng dẫn\n\nNội dung trên hub.",
    repoContent: "# Hướng dẫn\n\nNội dung trong repo.",
    merge: { content: "# Hướng dẫn\n\nNội dung trên hub.", conflicts: 1 },
  });
  const base: DocExtract = docExtract.parse({
    id: EXTRACT_ID,
    assetId: "23232323-0000-4000-8000-000000000006",
    homeId: HOME_ID,
    repoPath: "docs/huong-dan.docx",
    sourceSha256: "b".repeat(64),
    state: "review",
    secretFlag: options.secret ?? false,
    error: null,
    warnings: ["Kiểm tra lại định dạng bảng so với file gốc."],
    reviewedBy: null,
    reviewedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    content: "# Hướng dẫn\n\nBản trích cần kiểm tra.",
    findings: options.secret ? [{ kind: "github_token", line: 12 }] : [],
  });
  const state = {
    conflict,
    extracts: options.empty
      ? []
      : [
          base,
          docExtract.parse({
            ...base,
            id: PDF_EXTRACT_ID,
            assetId: "23232323-0000-4000-8000-000000000007",
            repoPath: "docs/khao-sat.pdf",
            secretFlag: false,
            findings: [],
            state: options.failed ? "failed" : "review",
            content: options.failed ? "" : "# Khảo sát",
            error: options.failed ? "Không có chữ để trích." : null,
          }),
        ],
    resolutions: [] as DocConflictResolveInput[],
    actions: [] as { kind: string; id: string; updatedAt: string; content?: string }[],
    conflictStale: options.conflictStale ?? false,
    extractStale: options.extractStale ?? false,
    secretOnApprove: options.secretOnApprove ?? false,
  };
  let tick = 0;
  const stamp = () => new Date(Date.parse(NOW) + ++tick * 1000).toISOString();
  const denied = () => fail("FORBIDDEN", 403, "Bạn không có quyền quản lý tài liệu này.");
  const rpc: Record<string, DocsyncFixtureHandler> = {
    "docConflicts/get": () => (options.forbidden ? denied() : ok(structuredClone(state.conflict))),
    "docConflicts/list": () => ok({ items: [state.conflict], nextCursor: null }),
    "docConflicts/resolve": (input) => {
      const parsed = docConflictResolveInput.parse(input);
      if (options.forbidden) return denied();
      if (state.conflictStale) {
        state.conflictStale = false;
        state.conflict = {
          ...state.conflict,
          hubVersion: 3,
          hubContent: "# Hướng dẫn\n\nHub vừa cập nhật.",
          updatedAt: stamp(),
        };
        return fail("CONFLICT", 409, "Tài liệu vừa đổi.", { code: "VERSION_CONFLICT" });
      }
      if (parsed.baseVersion !== state.conflict.hubVersion)
        return fail("CONFLICT", 409, "Phiên bản đã đổi.", { code: "VERSION_CONFLICT" });
      state.resolutions.push(parsed);
      state.conflict = {
        ...state.conflict,
        state: "resolved",
        resolution: parsed.choice,
        resolvedVersion: parsed.baseVersion + 1,
        updatedAt: stamp(),
      };
      return ok({ key: state.conflict.key, version: parsed.baseVersion + 1 });
    },
    "docExtracts/list": (input) => {
      if (options.forbidden) return denied();
      const { state: filter, cursor } = input as { state?: string; cursor?: string };
      const items = state.extracts.filter((item) => !filter || item.state === filter);
      const offset = cursor ? Number(cursor) : 0;
      const count = options.pages ? 1 : 50;
      return ok({
        items: items.slice(offset, offset + count).map((item) => docExtractSummary.parse(item)),
        nextCursor: offset + count < items.length ? String(offset + count) : null,
      });
    },
    "docExtracts/get": (input) =>
      options.forbidden
        ? denied()
        : ok(structuredClone(state.extracts.find((item) => item.id === (input as { id: string }).id))),
  };
  for (const kind of ["update", "approve", "reject", "confirmSecret"] as const) {
    rpc[`docExtracts/${kind}`] = (input) => {
      if (options.forbidden) return denied();
      const parsed =
        kind === "update"
          ? docExtractUpdateInput.parse(input)
          : (input as { id: string; updatedAt: string; content?: string });
      const item = state.extracts.find((item) => item.id === parsed.id);
      if (!item) return fail("NOT_FOUND", 404, "Không tìm thấy bản trích.");
      if (state.extractStale) {
        state.extractStale = false;
        item.updatedAt = stamp();
        item.content = "# Bản trích mới nhất";
        return fail("CONFLICT", 409, "Bản trích vừa đổi.", { code: "VERSION_CONFLICT" });
      }
      if (parsed.updatedAt !== item.updatedAt)
        return fail("CONFLICT", 409, "Bản trích vừa đổi.", { code: "VERSION_CONFLICT" });
      if (kind === "approve" && state.secretOnApprove) {
        state.secretOnApprove = false;
        item.secretFlag = true;
        item.findings = [{ kind: "github_token", line: 12 }];
        return fail("DOC_SECRET_FOUND", 400, "Có dấu hiệu bí mật.", {
          code: "DOC_SECRET_FOUND",
          findings: item.findings,
        });
      }
      if (kind === "approve" && item.secretFlag)
        return fail("DOC_SECRET_FOUND", 400, "Có dấu hiệu bí mật.", {
          code: "DOC_SECRET_FOUND",
          findings: item.findings,
        });
      state.actions.push({ kind, ...parsed });
      if (kind === "update") item.content = parsed.content ?? "";
      if (kind === "approve" || kind === "reject") {
        item.state = kind === "approve" ? "approved" : "rejected";
        item.reviewedBy = "u1";
        item.reviewedAt = stamp();
      }
      if (kind === "confirmSecret") {
        item.secretFlag = false;
        item.findings = [];
      }
      item.updatedAt = stamp();
      return ok(structuredClone(item));
    };
  }
  return { state, rpc };
}

export function docsyncReviewFixture(): Record<string, DocsyncFixtureHandler> {
  return docsyncReviewScenario().rpc;
}
