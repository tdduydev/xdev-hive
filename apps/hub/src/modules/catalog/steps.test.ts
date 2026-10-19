import { describe, expect, it } from "vitest";
import { createMemoryProvider, GitProviderError } from "../scm/index.ts";
import { describeFailure, planSteps, protectionFor, StepFailure, splitTemplateFiles } from "./steps.ts";

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
    expect(steps[1]?.title).toBe("Mở PR hive/khoi-tao với file mẫu repo chưa có");
  });

  it("repo có sẵn: tiêu đề nêu file sẽ thêm và file của đội được giữ nguyên", () => {
    const steps = planSteps({
      ...base,
      mode: "existing",
      defaultBranch: "dev",
      visibility: null,
      webhook: false,
      templateFiles: { add: ["AGENTS.md", ".mcp.json"], keep: ["CLAUDE.md", "README.md"] },
    });
    expect(steps[1]?.title).toBe("Mở PR hive/khoi-tao thêm AGENTS.md, .mcp.json; giữ nguyên CLAUDE.md, README.md");
  });

  it("repo có sẵn đã đủ file mẫu: báo không mở PR", () => {
    const steps = planSteps({
      ...base,
      mode: "existing",
      defaultBranch: "dev",
      visibility: null,
      webhook: false,
      templateFiles: { add: [], keep: ["AGENTS.md", "CLAUDE.md"] },
    });
    expect(steps[1]?.title).toBe("Không mở PR: repo đã có AGENTS.md, CLAUDE.md");
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

describe("splitTemplateFiles", () => {
  const files = ["AGENTS.md", "CLAUDE.md", ".mcp.json", "README.md"].map((path) => ({ path, content: `mẫu ${path}` }));
  const ref = { owner: "xdev-team", name: "his-portal" };

  it("file repo đã có thì giữ nguyên, chỉ thêm file còn thiếu", async () => {
    const mem = createMemoryProvider("gitlab", ["xdev-team"]);
    mem.seedRepo(ref, { defaultBranch: "dev", files: { "CLAUDE.md": "# Đội\n", "README.md": "# Đội\n" } });
    const r = await splitTemplateFiles(mem, ref, "dev", files);
    expect(r.add.map((f) => f.path)).toEqual(["AGENTS.md", ".mcp.json"]);
    expect(r.keep).toEqual(["CLAUDE.md", "README.md"]);
  });

  it("nhánh chưa có thì thêm hết", async () => {
    const mem = createMemoryProvider("gitlab", ["xdev-team"]);
    mem.seedRepo(ref, { defaultBranch: "dev" });
    const r = await splitTemplateFiles(mem, ref, "khong-co", files);
    expect(r.add.map((f) => f.path)).toEqual(files.map((f) => f.path));
    expect(r.keep).toEqual([]);
  });
});

describe("protectionFor", () => {
  it("repo có sẵn mặc định không bảo vệ nhánh vì sẽ thay quy tắc đang có; repo mới mặc định bảo vệ", () => {
    expect(protectionFor("existing", { requiredApprovals: 1 })).toEqual({
      protectDefault: false,
      requiredApprovals: 1,
    });
    expect(protectionFor("new", { requiredApprovals: 1 })).toEqual({ protectDefault: true, requiredApprovals: 1 });
  });

  it("người tạo chọn thì theo lựa chọn đó", () => {
    expect(protectionFor("existing", { protectDefault: true, requiredApprovals: 2 })).toEqual({
      protectDefault: true,
      requiredApprovals: 2,
    });
    expect(protectionFor("new", { protectDefault: false, requiredApprovals: 0 })).toEqual({
      protectDefault: false,
      requiredApprovals: 0,
    });
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
