import { describe, expect, it } from "vitest";
import { createMemoryProvider } from "../scm/index.ts";
import { buildStepPrompt, type StepPromptInput, sdlcJobForMachine } from "./prompt.ts";
import { DIGEST_MAX_CHARS, repoDigest, treeOf } from "./repo-digest.ts";

const input = (over: Partial<StepPromptInput> = {}): StepPromptInput => ({
  item: {
    number: 12,
    slug: "hoan-tien",
    title: "Hoàn tiền",
    idea: "Cho phép hoàn tiền một phần.",
    size: "M",
    createdAt: new Date("2026-10-14T08:00:00Z"),
  },
  phaseName: "Specify",
  step: {
    action: "draft",
    prompt: "Ý tưởng:\n{idea}\n\n{artifacts}\n\n{answers}\n\n{feedback}\n\n{constitution}\n\n{projects}\n\n{lạ}",
    maxQuestions: 5,
    skill: "speckit-specify",
  },
  outputs: [{ name: "spec.md", path: "specs/012-hoan-tien/spec.md", sections: ["Requirements"], projectKey: null }],
  context: [],
  answers: [],
  feedback: null,
  projects: [{ key: "shop", role: "home", digestPath: null }],
  contracts: [],
  ...over,
});

describe("buildStepPrompt", () => {
  it("điền biến, giữ biến lạ, kèm luật của hub", () => {
    const p = buildStepPrompt(input());
    expect(p).toContain("Hạng mục 012 · Hoàn tiền (cỡ M) · giai đoạn Specify · bước draft.");
    expect(p).toContain("Cho phép hoàn tiền một phần.");
    expect(p).toContain("- spec.md → `specs/012-hoan-tien/spec.md`; mục bắt buộc: Requirements");
    expect(p).toContain("Chưa có câu trả lời nào");
    expect(p).toContain("Không có góp ý");
    expect(p).toContain(".specify/memory/constitution.md");
    expect(p).toContain("Hạng mục chỉ thuộc dự án shop.");
    expect(p).toContain("{lạ}");
    expect(p).toContain("`sdlc_ask` (tối đa 5 câu");
    expect(p).toContain("Không sửa code, không commit");
  });

  it("câu trả lời, góp ý, tài liệu đã có, contract và tóm tắt repo tham gia", () => {
    const p = buildStepPrompt(
      input({
        answers: [{ text: "Hoàn tối đa bao nhiêu?", answer: "50% giá trị đơn" }],
        feedback: "Thiếu tiêu chí cho đơn đã giao.",
        context: [{ name: "spec.md", path: "specs/012-hoan-tien/spec.md", state: "baseline", version: 3 }],
        projects: [
          { key: "api", role: "home", digestPath: null },
          { key: "web", role: "participant", digestPath: ".hive/sdlc/projects/web.md" },
          { key: "app", role: "participant", digestPath: null },
        ],
        contracts: [
          {
            name: "refund-api",
            path: "specs/012-hoan-tien/contracts/refund-api.yaml",
            provider: "api",
            consumers: ["web"],
            approved: true,
          },
        ],
      }),
    );
    expect(p).toContain("1. Hoàn tối đa bao nhiêu?\n   → 50% giá trị đơn");
    expect(p).toContain("Góp ý cần sửa trong lượt này:\nThiếu tiêu chí cho đơn đã giao.");
    expect(p).toContain("`specs/012-hoan-tien/spec.md` (bản đã duyệt v3)");
    expect(p).toContain("- web: tóm tắt repo ở `.hive/sdlc/projects/web.md`");
    expect(p).toContain("- app: hub chưa đọc được repo");
    expect(p).toContain(
      "refund-api: `specs/012-hoan-tien/contracts/refund-api.yaml` (api cung cấp cho web; đã duyệt, phải theo)",
    );
  });

  it("chế độ bỏ {artifacts} vẫn nhận danh sách file; bước không ghi file thì báo bằng sdlc_report", () => {
    const own = buildStepPrompt(input({ step: { action: "draft", prompt: "Viết spec.", maxQuestions: 0 } }));
    expect(own).toContain("specs/012-hoan-tien/spec.md");
    expect(own).toContain("Không hỏi lại người giao");
    const analyze = buildStepPrompt(
      input({ step: { action: "analyze", prompt: "Đọc chéo {artifacts}", maxQuestions: 0 }, outputs: [] }),
    );
    expect(analyze).toContain("Bước này không ghi file: báo kết quả bằng MCP `sdlc_report`.");
    expect(analyze).toContain("Chưa có tài liệu nào.");
  });

  it("{NNN}, {slug}, {date} trong prompt theo hạng mục", () => {
    const p = buildStepPrompt(
      input({ step: { action: "draft", prompt: "Ghi vào {date}-{slug} số {NNN}.", maxQuestions: 5 } }),
    );
    expect(p).toContain("Ghi vào 2026-10-14-hoan-tien số 012.");
  });
});

describe("tóm tắt repo tham gia", () => {
  it("cây hai cấp gộp thư mục con, file ở gốc", () => {
    expect(treeOf(["README.md", "src/a.ts", "src/lib/b.ts", "src/lib/c.ts", "docs/x.md"])).toBe(
      ["docs/ (1 file)", "  x.md", "src/ (3 file)", "  a.ts", "  lib/", "README.md"].join("\n"),
    );
  });

  it("README, manifest, contract có sẵn; cắt ở giới hạn; cache theo SHA đầu nhánh", async () => {
    const scm = createMemoryProvider("github", ["acme"]);
    const repo = { owner: "acme", name: "web" };
    scm.seedRepo(repo, {
      files: {
        "README.md": "# Web shop\nỨng dụng bán hàng.",
        "package.json": '{"name":"web"}',
        "api/openapi.yaml": "openapi: 3.1.0",
        "src/app.ts": "x".repeat(DIGEST_MAX_CHARS + 10),
      },
    });
    const digest = await repoDigest({ provider: scm, repo, projectKey: "web", branch: "main" });
    expect(digest).toContain("# Repo web (acme/web, nhánh main");
    expect(digest).toContain("Ứng dụng bán hàng.");
    expect(digest).toContain('{"name":"web"}');
    expect(digest).toContain("## Contract api/openapi.yaml");
    expect(digest).not.toContain("xxxx");
    expect((digest ?? "").length).toBeLessThanOrEqual(DIGEST_MAX_CHARS + 100);

    let reads = 0;
    const counting = {
      ...scm,
      readFile: async (...a: Parameters<typeof scm.readFile>) => {
        reads++;
        return scm.readFile(...a);
      },
    };
    expect(await repoDigest({ provider: counting, repo, projectKey: "web", branch: "main" })).toBe(digest);
    expect(reads).toBe(0);
    expect(await repoDigest({ provider: scm, repo, projectKey: "web", branch: "khong-co" })).toBeNull();
  });
});

describe("sdlcJobForMachine (T086)", () => {
  const repo = {
    projectKey: "billing",
    cloneUrl: "https://gitlab.com/x/billing.git",
    branch: "main",
    dir: ".hive/repos/billing",
  };
  const job = { step: "draft-spec", seed: [], collect: [], repos: [repo] };

  it("bỏ repos với máy không khai sdlc-multirepo, prompt giữ nguyên", () => {
    const out = sdlcJobForMachine(job, "Soạn spec.", ["sdlc"]);
    expect(out.job).toEqual({ step: "draft-spec", seed: [], collect: [] });
    expect(out.prompt).toBe("Soạn spec.");
  });

  it("máy có capability giữ repos và prompt chỉ chỗ checkout, STATUS.md", () => {
    const out = sdlcJobForMachine(job, "Soạn spec.", ["sdlc", "sdlc-multirepo"]);
    expect(out.job.repos).toEqual([repo]);
    expect(out.prompt).toMatch(/^Soạn spec\.\n\n/);
    expect(out.prompt).toContain("`.hive/repos/<mã dự án>/` (billing)");
    expect(out.prompt).toContain(".hive/repos/STATUS.md");
  });

  it("không có repos thì không thêm gì", () => {
    const out = sdlcJobForMachine({ step: "s", seed: [], collect: [] }, null, ["sdlc-multirepo"]);
    expect(out).toEqual({ job: { step: "s", seed: [], collect: [] }, prompt: null });
  });
});
