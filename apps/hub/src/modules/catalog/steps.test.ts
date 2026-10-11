import { describe, expect, it } from "vitest";
import { GitProviderError } from "../scm/index.ts";
import { describeFailure, planSteps, StepFailure } from "./steps.ts";

const base = {
  scmKind: "github" as const,
  owner: "xdev-team",
  name: "hoa-don",
  visibility: "private" as const,
  protection: { protectDefault: true, requiredApprovals: 2 },
  webhook: true,
  webhookUrl: "https://hive.example.com/hooks/git",
  templateFileCount: 4,
};

describe("planSteps", () => {
  it("repo mới: kiểm quyền, tạo repo, commit thẳng vào nhánh chính", () => {
    const steps = planSteps({ ...base, mode: "new", defaultBranch: "main" });
    expect(steps.map((s) => s.title)).toEqual([
      "Kiểm quyền của kết nối trên xdev-team",
      "Tạo repo xdev-team/hoa-don (private)",
      "Commit 4 file mẫu vào main",
      "Bảo vệ main: cần 2 người duyệt, cấm force push",
      "Thêm webhook về https://hive.example.com/hooks/git",
    ]);
    expect(steps[3]?.params).toEqual({ requiredApprovals: 2 });
  });

  it("repo có sẵn: đọc repo, file mẫu qua PR", () => {
    const steps = planSteps({ ...base, mode: "existing", defaultBranch: null, visibility: null, webhook: false });
    expect(steps.map((s) => s.kind)).toEqual(["link-repo", "commit-template", "protect-branch"]);
    expect(steps[1]?.title).toBe("Mở PR hive/khoi-tao với 4 file mẫu");
  });

  it("0 người duyệt vẫn bắt buộc qua PR", () => {
    const steps = planSteps({
      ...base,
      mode: "new",
      defaultBranch: "main",
      protection: { protectDefault: true, requiredApprovals: 0 },
    });
    expect(steps.find((s) => s.kind === "protect-branch")?.title).toContain("chỉ qua PR");
  });
});

describe("describeFailure", () => {
  it("GitHub thiếu quyền bảo vệ nhánh: chỉ cách cấp Administration", () => {
    const e = describeFailure(
      "protect-branch",
      "github",
      "xdev-team",
      new GitProviderError("forbidden", "GitHub: không đủ quyền"),
    );
    expect(e.code).toBe("SCM_FORBIDDEN");
    expect(e.fix).toContain("Administration (ghi)");
    expect(e.fix).toContain("xdev-team");
  });

  it("GitHub token thiếu quyền webhook: chỉ cách sửa token, không nhắc GitHub App", () => {
    const e = describeFailure(
      "add-webhook",
      "github",
      "xdev-team",
      new GitProviderError("forbidden", "GitHub: không đủ quyền"),
      "token",
    );
    expect(e.fix).toContain("Token GitHub thiếu quyền Webhooks");
    expect(e.fix).not.toContain("GitHub Apps");
  });

  it("GitLab thiếu quyền: nói vai trò cần có", () => {
    const e = describeFailure(
      "add-webhook",
      "gitlab",
      "nhom",
      new GitProviderError("forbidden", "GitLab: không đủ quyền"),
    );
    expect(e.fix).toContain("Maintainer");
  });

  it("repo trùng tên không do Hive tạo", () => {
    const e = describeFailure("create-repo", "github", "x", new GitProviderError("conflict", "GitHub: đã có"));
    expect(e.fix).toContain("repo có sẵn");
  });

  it("giữ nguyên lỗi nghiệp vụ của bước", () => {
    expect(describeFailure("link-repo", "github", "x", new StepFailure("REPO_NOT_FOUND", "không thấy", "sửa"))).toEqual(
      {
        code: "REPO_NOT_FOUND",
        message: "không thấy",
        fix: "sửa",
      },
    );
  });

  it("lỗi lạ thành INTERNAL, không ném tiếp", () => {
    expect(describeFailure("commit-template", "github", "x", new Error("hỏng")).code).toBe("INTERNAL");
  });
});
