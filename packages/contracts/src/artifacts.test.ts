import { describe, expect, it } from "vitest";
import {
  ARTIFACT_ERRORS,
  ARTIFACT_LIMITS,
  artifactAskLeaderFix,
  artifactCreate,
  artifactErrorData,
  artifactListQuery,
  artifactPublicLinkCreate,
  artifactSetScopeInput,
  artifactsContract,
  artifactToolCreate,
  artifactToolList,
  artifactWebPath,
} from "./artifacts.ts";
import { contract } from "./index.ts";
import { chatMessage } from "./leader.ts";
import { notificationEvent } from "./notify.ts";
import { agentPolicy, agentPolicyInput, DEFAULT_AGENT_POLICY, orgArtifactPolicy } from "./policies.ts";

const ID = "7f3c2a10-5b7e-4c1d-9a2b-3c4d5e6f7a8b";
const pageError = (message = "TypeError: x is undefined") => ({ kind: "error" as const, message });

describe("orgArtifactPolicy", () => {
  it("chính sách lưu trước specs/012 không có mục artifacts vẫn đọc được", () => {
    const parsed = agentPolicyInput.parse(JSON.parse(JSON.stringify(DEFAULT_AGENT_POLICY)));
    expect(parsed.artifacts).toBeUndefined();
    expect(
      agentPolicy.safeParse({
        ...DEFAULT_AGENT_POLICY,
        updatedAt: null,
        updatedBy: null,
        templateSync: null,
        defaultTemplates: { agents: "", claude: "", mcp: "" },
      }).success,
    ).toBe(true);
  });

  it("mục rỗng ra đủ mặc định của C10", () => {
    expect(orgArtifactPolicy.parse({})).toEqual({
      enabled: true,
      types: ["markdown", "code", "html", "mermaid", "react"],
      scopes: ["private", "project"],
      maxVersionBytes: 1024 * 1024,
      maxBlobBytes: 20 * 1024 * 1024,
      maxVersions: 200,
      runLimits: { artifacts: 20, versions: 100 },
      orgQuotaBytes: 2 * 1024 * 1024 * 1024,
      publicLinks: { enabled: true, maxDays: 30 },
    });
  });

  it("điền mặc định cho trường thiếu bên trong mục con", () => {
    const parsed = orgArtifactPolicy.parse({ publicLinks: { enabled: false }, runLimits: { artifacts: 5 } });
    expect(parsed.publicLinks).toEqual({ enabled: false, maxDays: 30 });
    expect(parsed.runLimits).toEqual({ artifacts: 5, versions: 100 });
  });

  it("maxDays chỉ nhận 1…30", () => {
    for (const maxDays of [1, 30]) expect(orgArtifactPolicy.safeParse({ publicLinks: { maxDays } }).success).toBe(true);
    for (const maxDays of [0, 31, 7.5])
      expect(orgArtifactPolicy.safeParse({ publicLinks: { maxDays } }).success).toBe(false);
  });

  it("không có trường nới khung cách ly hay chế độ quét bí mật", () => {
    const parsed = orgArtifactPolicy.parse({ cdnAllow: ["https://cdn.example.com"], secretScan: "redact" });
    expect(parsed).not.toHaveProperty("cdnAllow");
    expect(parsed).not.toHaveProperty("secretScan");
  });

  it("từ chối loại hay phạm vi lạ và số vượt trần", () => {
    expect(orgArtifactPolicy.safeParse({ types: ["exe"] }).success).toBe(false);
    expect(orgArtifactPolicy.safeParse({ scopes: ["public"] }).success).toBe(false);
    expect(orgArtifactPolicy.safeParse({ maxVersions: ARTIFACT_LIMITS.maxVersionsCeiling + 1 }).success).toBe(false);
    expect(orgArtifactPolicy.safeParse({ maxVersionBytes: 0 }).success).toBe(false);
  });
});

describe("askLeaderFix", () => {
  const base = { id: ID, version: 4, errors: [pageError()] };

  it("nhận tới 20 lỗi, mỗi lỗi tới 2 000 ký tự", () => {
    const errors = Array.from({ length: 20 }, () => pageError("x".repeat(2000)));
    expect(artifactAskLeaderFix.safeParse({ ...base, errors }).success).toBe(true);
  });

  it("từ chối quá 20 lỗi", () => {
    const errors = Array.from({ length: 21 }, () => pageError());
    expect(artifactAskLeaderFix.safeParse({ ...base, errors }).success).toBe(false);
  });

  it("từ chối lỗi dài quá 2 000 ký tự và lời nhắn quá dài", () => {
    expect(artifactAskLeaderFix.safeParse({ ...base, errors: [pageError("x".repeat(2001))] }).success).toBe(false);
    expect(artifactAskLeaderFix.safeParse({ ...base, note: "x".repeat(2001) }).success).toBe(false);
  });

  it("chỉ nhận loại lỗi error, console, compile", () => {
    for (const kind of ["error", "console", "compile"])
      expect(artifactAskLeaderFix.safeParse({ ...base, errors: [{ kind, message: "m" }] }).success).toBe(true);
    expect(artifactAskLeaderFix.safeParse({ ...base, errors: [{ kind: "network", message: "m" }] }).success).toBe(
      false,
    );
  });
});

describe("chatMessage", () => {
  const old = { id: ID, role: "leader", content: "Xin chào", runId: null, createdAt: "2026-10-14T00:00:00.000Z" };

  it("tin nhắn của hub cũ có artifact và pageErrors là null", () => {
    expect(chatMessage.parse(old)).toMatchObject({ artifact: null, pageErrors: null });
  });

  it("đọc thẻ artifact và lỗi trang", () => {
    const parsed = chatMessage.parse({
      ...old,
      artifact: { id: ID, version: 2, title: "Luồng hoàn tiền", type: "mermaid" },
      pageErrors: [pageError()],
    });
    expect(parsed.artifact).toEqual({ id: ID, version: 2, title: "Luồng hoàn tiền", type: "mermaid", deleted: false });
    expect(parsed.pageErrors).toHaveLength(1);
  });
});

describe("đầu vào", () => {
  const create = { type: "markdown", title: "Checklist release 1.4", content: "- [ ] tag" };

  it("phạm vi dự án cần dự án, phạm vi đội cần đội", () => {
    expect(artifactCreate.safeParse(create).success).toBe(true);
    expect(artifactCreate.safeParse({ ...create, scope: "project" }).success).toBe(false);
    expect(artifactCreate.safeParse({ ...create, scope: "project", projectKey: "payment-api" }).success).toBe(true);
    expect(artifactSetScopeInput.safeParse({ id: ID, scope: "team" }).success).toBe(false);
    expect(artifactSetScopeInput.safeParse({ id: ID, scope: "team", teamId: ID }).success).toBe(true);
  });

  it("tiêu đề 1…200 ký tự sau khi bỏ khoảng trắng", () => {
    expect(artifactCreate.safeParse({ ...create, title: "   " }).success).toBe(false);
    expect(artifactCreate.safeParse({ ...create, title: "x".repeat(201) }).success).toBe(false);
  });

  it("tool của agent chỉ tạo private hoặc project và có duplicateOf", () => {
    expect(artifactToolCreate.safeParse({ ...create, scope: "org" }).success).toBe(false);
    const dup = artifactToolCreate.parse({ ...create, threadId: ID, duplicateOf: { id: ID, version: 3 } });
    expect(dup.duplicateOf).toEqual({ id: ID, version: 3 });
  });

  it("artifact_list không có thùng rác; thư viện đổi cờ query thành boolean", () => {
    expect(artifactToolList.parse({ trash: true })).not.toHaveProperty("trash");
    expect(artifactListQuery.parse({ trash: "true", mine: "false", limit: "20" })).toMatchObject({
      trash: true,
      mine: false,
      limit: 20,
    });
    expect(artifactListQuery.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("link công khai mặc định 7 ngày, tối đa 30", () => {
    expect(artifactPublicLinkCreate.parse({ id: ID, version: "4" })).toEqual({ id: ID, version: 4, expiresInDays: 7 });
    expect(artifactPublicLinkCreate.safeParse({ id: ID, version: 4, expiresInDays: 31 }).success).toBe(false);
    expect(artifactPublicLinkCreate.safeParse({ id: ID, version: 4, expiresInDays: 0 }).success).toBe(false);
  });

  it("Lưu vào repo chặn đường dẫn cấm và biến khuôn", () => {
    const input = artifactsContract.toRepo["~orpc"].inputSchema;
    const save = (path: string) =>
      input?.["~standard"].validate({ id: ID, version: 1, projectKey: "payment-api", path });
    expect(save("docs/diagrams/refund.mmd")).toMatchObject({ value: { path: "docs/diagrams/refund.mmd" } });
    for (const path of [".github/workflows/ci.yml", "../x.md", "docs/{NNN}.md", ".git/config", "/etc/passwd"])
      expect(save(path)).toHaveProperty("issues");
  });
});

describe("lỗi", () => {
  it("có đủ mã ARTIFACT_* của plan", () => {
    for (const code of [
      "ARTIFACT_NOT_FOUND",
      "ARTIFACT_VERSION_CONFLICT",
      "ARTIFACT_VERSION_LIMIT",
      "ARTIFACT_TOO_LARGE",
      "ARTIFACT_RUN_LIMIT",
      "ARTIFACT_QUOTA_EXCEEDED",
      "ARTIFACT_SECRET_FOUND",
      "ARTIFACT_TYPE_DISABLED",
      "ARTIFACT_SCOPE_DISABLED",
      "ARTIFACT_SCOPE_TOO_NARROW",
      "ARTIFACT_LINK_FORBIDDEN",
      "ARTIFACT_RUN_KIND",
      "ARTIFACT_IMPORT_NOT_ALLOWED",
      "ARTIFACTS_DISABLED",
      "ARTIFACT_LINK_OWNER_ONLY",
      "ARTIFACT_LINK_LIMIT",
      "ARTIFACT_PUBLIC_LINKS_DISABLED",
      "ARTIFACT_LINK_EXPIRY_INVALID",
    ])
      expect(ARTIFACT_ERRORS).toHaveProperty(code);
  });

  it("dữ liệu lỗi mang dòng và loại bí mật, bản mới nhất khi xung đột", () => {
    const secret = { code: "ARTIFACT_SECRET_FOUND", findings: [{ line: 12, kind: "github_token" }] };
    expect(artifactErrorData.parse(secret)).toEqual(secret);
    const conflict = { code: "ARTIFACT_VERSION_CONFLICT", latest: { version: 2, content: "graph TD" } };
    expect(artifactErrorData.parse(conflict)).toEqual(conflict);
    expect(artifactErrorData.safeParse({ code: "X", findings: [{ line: 0, kind: "github_token" }] }).success).toBe(
      false,
    );
  });

  it("BAD_REQUEST vẫn nhận lỗi kiểm đầu vào của oRPC (có issues, không có code)", async () => {
    const data = artifactsContract.create["~orpc"].errorMap.BAD_REQUEST.data;
    const issues = { issues: [{ message: "Tiêu đề không được để trống.", path: ["title"] }] };
    expect(await data["~standard"].validate(issues)).toEqual({ value: issues });
    expect(await data["~standard"].validate({ code: "ARTIFACT_TOO_LARGE", limit: 1024 })).toHaveProperty("value");
  });
});

describe("hợp đồng", () => {
  it("có route của MVP và sau MVP để openapi.json ổn định", () => {
    expect(contract.artifacts).toBe(artifactsContract);
    expect(Object.keys(artifactsContract.publicLinks).sort()).toEqual(["create", "list", "orgList", "revoke"]);
    for (const route of ["askLeaderFix", "frameUrl", "preview", "frameDocument", "usage", "toDoc", "toRepo"])
      expect(artifactsContract).toHaveProperty(route);
  });

  it("có hai loại thông báo của artifact", () => {
    expect(notificationEvent.options).toEqual(
      expect.arrayContaining(["artifact.quota", "artifact.public_link.revoked"]),
    );
  });

  it("đường dẫn web của phiên bản", () => {
    expect(artifactWebPath(ID, 3)).toBe(`/artifacts/${ID}/v/3`);
    expect(artifactWebPath(ID)).toBe(`/artifacts/${ID}`);
  });
});
