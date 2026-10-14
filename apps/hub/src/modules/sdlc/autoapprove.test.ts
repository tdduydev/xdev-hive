import { DEFAULT_ORG_SDLC_POLICY, projectSdlcSettings } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { type AutoDecideInput, decide } from "./autoapprove.ts";

const projectAuto = (patch: Record<string, unknown> = {}) =>
  projectSdlcSettings.parse({ autoApprove: { enabled: true, ...patch } }).autoApprove;

/** Ca đạt mọi điều kiện; mỗi test đổi đúng một thứ để chứng minh điều kiện đó chặn được. */
const base = (patch: Partial<AutoDecideInput> = {}): AutoDecideInput => ({
  org: DEFAULT_ORG_SDLC_POLICY.autoApprove,
  projects: [{ key: "web-shop", autoApprove: projectAuto() }],
  mode: { sizes: ["S", "M"] },
  item: { size: "M" },
  phase: { id: "tasks", kind: "decomposition", autoApprove: { gates: ["human"], minScore: 9, revokeHours: 24 } },
  gateId: "human",
  artifact: { scope: "item" },
  ai: {
    reviewers: [{ cli: "codex", model: "gpt-5", score: 9.3 }],
    worstFinding: null,
    failedChecks: [],
  },
  author: { cli: "claude", model: "claude-sonnet-5-5" },
  changedText: "Thêm trang danh sách đơn hàng.",
  paths: ["apps/web/src/pages/orders.tsx"],
  ...patch,
});

const requirementsPhase: AutoDecideInput["phase"] = {
  id: "requirements",
  kind: "requirements",
  autoApprove: { gates: ["human"], minScore: 9, revokeHours: 24 },
};

const refused = (input: AutoDecideInput) => {
  const d = decide(input);
  if (d.approve) throw new Error("đáng lẽ phải từ chối");
  return d;
};

describe("decide — đạt", () => {
  it("đủ điều kiện: duyệt, trả điểm thấp nhất, ngưỡng và hạn thu hồi", () => {
    expect(decide(base())).toEqual({ approve: true, score: 9.3, threshold: 9, revokeHours: 24, reasons: [] });
  });

  it("điểm là mức thấp nhất của các reviewer", () => {
    const d = decide(
      base({
        ai: {
          reviewers: [
            { cli: "codex", model: null, score: 9.8 },
            { cli: "gemini", model: null, score: 9.1 },
          ],
          worstFinding: "minor",
          failedChecks: [],
        },
      }),
    );
    expect(d).toMatchObject({ approve: true, score: 9.1 });
  });

  it("tác giả là người viết tay thì không có reviewer trùng", () => {
    expect(decide(base({ author: null })).approve).toBe(true);
  });

  it("dự án chỉ giai đoạn khác nhưng phases rỗng thì là mọi giai đoạn", () => {
    expect(decide(base({ projects: [{ key: "web-shop", autoApprove: projectAuto({ phases: [] }) }] })).approve).toBe(
      true,
    );
  });
});

describe("decide — từng điều kiện chặn (SC-014)", () => {
  it("tổ chức tắt tự duyệt", () => {
    const org = { ...DEFAULT_ORG_SDLC_POLICY.autoApprove, allowed: false };
    expect(refused(base({ org }))).toMatchObject({ silent: false, reasons: ["Tổ chức đã tắt tự duyệt."] });
  });

  it("tổ chức tắt thắng cả khi giai đoạn không cấu hình (hiện lý do, không im lặng)", () => {
    const org = { ...DEFAULT_ORG_SDLC_POLICY.autoApprove, allowed: false };
    expect(refused(base({ org, phase: { id: "tasks", kind: "decomposition" } })).silent).toBe(false);
  });

  it("giai đoạn không cho tự duyệt cổng này: im lặng, không có lý do", () => {
    expect(refused(base({ phase: { id: "tasks", kind: "decomposition" } }))).toEqual({
      approve: false,
      silent: true,
      reasons: [],
    });
    const other = { gates: ["lead"], minScore: 9, revokeHours: 24 };
    expect(refused(base({ phase: { id: "tasks", kind: "decomposition", autoApprove: other } })).silent).toBe(true);
  });

  it("dự án chưa bật", () => {
    const projects = [{ key: "web-shop", autoApprove: projectSdlcSettings.parse({}).autoApprove }];
    expect(refused(base({ projects })).reasons[0]).toContain("web-shop chưa bật tự duyệt");
  });

  it("dự án bỏ giai đoạn này", () => {
    const projects = [{ key: "web-shop", autoApprove: projectAuto({ phases: ["design"] }) }];
    expect(refused(base({ projects })).reasons[0]).toContain("web-shop chưa bật tự duyệt");
  });

  it("cổng chung: một dự án chưa bật là đủ để chặn, lý do nêu đúng dự án", () => {
    const projects = [
      { key: "web-shop", autoApprove: projectAuto() },
      { key: "payment-api", autoApprove: projectSdlcSettings.parse({}).autoApprove },
    ];
    const d = refused(base({ projects }));
    expect(d.reasons[0]).toContain("payment-api");
    expect(d.reasons[0]).not.toContain("web-shop");
  });

  it("hạng mục không có dự án nào", () => {
    expect(refused(base({ projects: [] })).reasons).toEqual(["Hạng mục chưa có dự án nào bật tự duyệt."]);
  });

  it("contract luôn cần người", () => {
    expect(refused(base({ artifact: { scope: "contract" } })).reasons).toEqual(["Contract luôn cần người duyệt."]);
  });

  it("yêu cầu nặng theo cỡ của chế độ, dù hạng mục cỡ nhỏ", () => {
    const phase = requirementsPhase;
    expect(decide(base({ phase })).approve).toBe(true);
    expect(refused(base({ phase, mode: { sizes: ["S", "XL"] }, item: { size: "S" } })).reasons[0]).toContain("nặng");
  });

  it("yêu cầu nặng theo cỡ của hạng mục, dù chế độ nhẹ", () => {
    const phase = requirementsPhase;
    expect(refused(base({ phase, item: { size: "L" } })).reasons[0]).toContain("nặng");
  });

  it("giai đoạn khác yêu cầu vẫn tự duyệt được khi hạng mục nặng", () => {
    expect(decide(base({ item: { size: "XL" } })).approve).toBe(true);
  });

  it("chưa có checkpoint AI đạt", () => {
    expect(refused(base({ ai: null })).reasons).toEqual(["Chưa có điểm review AI."]);
    expect(refused(base({ ai: { reviewers: [], worstFinding: null, failedChecks: [] } })).reasons).toEqual([
      "Chưa có điểm review AI.",
    ]);
  });

  it("reviewer chưa có điểm", () => {
    const ai = { reviewers: [{ cli: "codex", model: null, score: null }], worstFinding: null, failedChecks: [] };
    expect(refused(base({ ai })).reasons).toEqual(["Chưa có điểm review AI."]);
  });

  it("điểm dưới ngưỡng, nêu cả hai số", () => {
    const ai = { reviewers: [{ cli: "codex", model: "gpt-5", score: 8.7 }], worstFinding: null, failedChecks: [] };
    expect(refused(base({ ai })).reasons).toEqual(["Điểm 8.7 < ngưỡng 9."]);
  });

  it("phát hiện major hoặc critical chặn dù điểm cao; minor không chặn", () => {
    const ai = (worstFinding: "critical" | "major" | "minor") => ({
      reviewers: [{ cli: "codex", model: "gpt-5", score: 9.9 }],
      worstFinding,
      failedChecks: [],
    });
    expect(refused(base({ ai: ai("major") })).reasons[0]).toContain("major");
    expect(refused(base({ ai: ai("critical") })).reasons[0]).toContain("critical");
    expect(decide(base({ ai: ai("minor") })).approve).toBe(true);
  });

  it("mục kiểm trượt chặn dù điểm cao", () => {
    const ai = {
      reviewers: [{ cli: "codex", model: "gpt-5", score: 9.9 }],
      worstFinding: null,
      failedChecks: ["Có tiêu chí nghiệm thu"],
    };
    expect(refused(base({ ai })).reasons[0]).toContain("Có tiêu chí nghiệm thu");
  });

  it("reviewer trùng CLI và model với run tác giả", () => {
    const author = { cli: "codex", model: "gpt-5" };
    expect(refused(base({ author })).reasons).toEqual(["Reviewer trùng tác giả."]);
  });

  it("cùng CLI nhưng model khác thì khác tác giả; model chưa rõ thì coi là trùng", () => {
    expect(decide(base({ author: { cli: "codex", model: "gpt-5-mini" } })).approve).toBe(true);
    const ai = { reviewers: [{ cli: "codex", model: null, score: 9.5 }], worstFinding: null, failedChecks: [] };
    expect(refused(base({ ai, author: { cli: "codex", model: "gpt-5" } })).reasons).toEqual([
      "Reviewer trùng tác giả.",
    ]);
  });

  it("một trong nhiều reviewer trùng tác giả cũng chặn", () => {
    const ai = {
      reviewers: [
        { cli: "gemini", model: null, score: 9.5 },
        { cli: "claude", model: "claude-sonnet-5-5", score: 9.5 },
      ],
      worstFinding: null,
      failedChecks: [],
    };
    expect(refused(base({ ai })).reasons).toEqual(["Reviewer trùng tác giả."]);
  });

  it("từ khoá nhạy cảm của tổ chức, so bỏ dấu và không phân biệt hoa thường", () => {
    const d = refused(base({ changedText: "Cho phép HOAN TIEN trong 7 ngày." }));
    expect(d.reasons).toEqual(["Từ khoá nhạy cảm 'hoàn tiền'."]);
  });

  it("từ khoá có dấu của người viết khớp từ khoá không dấu của cấu hình", () => {
    const org = { ...DEFAULT_ORG_SDLC_POLICY.autoApprove, denyKeywords: ["thanh toan"] };
    expect(refused(base({ org, changedText: "Luồng thanh toán mới" })).reasons[0]).toContain("thanh toan");
  });

  it("từ khoá của dự án cộng thêm vào của tổ chức", () => {
    const projects = [{ key: "web-shop", autoApprove: projectAuto({ denyKeywords: ["voucher"] }) }];
    expect(refused(base({ projects, changedText: "Thêm Voucher giảm giá" })).reasons).toEqual([
      "Từ khoá nhạy cảm 'voucher'.",
    ]);
  });

  it("chỉ phần đổi được dò: văn bản đã duyệt trước đó không còn bị tính (changedText do bên gọi cắt)", () => {
    expect(decide(base({ changedText: "" })).approve).toBe(true);
  });

  it("đường dẫn nhạy cảm của tổ chức khớp glob", () => {
    const d = refused(base({ paths: ["apps/hub/src/modules/identity/auth/session.ts"] }));
    expect(d.reasons).toEqual(["Đường dẫn nhạy cảm apps/hub/src/modules/identity/auth/session.ts."]);
  });

  it("đường dẫn ghi ./ hay / đầu vẫn khớp glob; thư mục gốc `.github/**`", () => {
    expect(refused(base({ paths: ["./.github/workflows/ci.yml"] })).reasons[0]).toContain(".github/workflows/ci.yml");
    expect(refused(base({ paths: ["/apps/hub/db/migrations/0001.sql"] })).reasons[0]).toContain("migrations");
  });

  it("glob của dự án cộng thêm vào của tổ chức", () => {
    const projects = [{ key: "web-shop", autoApprove: projectAuto({ denyPaths: ["infra/prod/**"] }) }];
    expect(refused(base({ projects, paths: ["infra/prod/main.tf"] })).reasons[0]).toContain("infra/prod/main.tf");
  });
});

describe("decide — ngưỡng hiệu lực và hạn thu hồi", () => {
  const withScore = (score: number, patch: Partial<AutoDecideInput> = {}) =>
    base({
      ai: { reviewers: [{ cli: "codex", model: "gpt-5", score }], worstFinding: null, failedChecks: [] },
      ...patch,
    });

  it("ngưỡng là số lớn nhất của chế độ, dự án và sàn tổ chức", () => {
    // Chế độ 9, dự án 9.5, sàn tổ chức 8 → 9.5.
    const projects = [{ key: "web-shop", autoApprove: projectAuto({ minScore: 9.5 }) }];
    expect(refused(withScore(9.4, { projects })).reasons).toEqual(["Điểm 9.4 < ngưỡng 9.5."]);
    expect(decide(withScore(9.5, { projects })).approve).toBe(true);
  });

  it("sàn tổ chức cao hơn ngưỡng chế độ thì sàn thắng", () => {
    const org = { ...DEFAULT_ORG_SDLC_POLICY.autoApprove, minScoreFloor: 9.6 };
    expect(refused(withScore(9.5, { org })).reasons).toEqual(["Điểm 9.5 < ngưỡng 9.6."]);
  });

  it("dự án đặt ngưỡng thấp hơn chế độ thì không hạ được ngưỡng", () => {
    const projects = [{ key: "web-shop", autoApprove: projectAuto({ minScore: 5 }) }];
    expect(refused(withScore(8.9, { projects })).reasons).toEqual(["Điểm 8.9 < ngưỡng 9."]);
  });

  it("cổng chung: lấy ngưỡng cao nhất của các dự án", () => {
    const projects = [
      { key: "web-shop", autoApprove: projectAuto({ minScore: 9.2 }) },
      { key: "payment-api", autoApprove: projectAuto({ minScore: 9.7 }) },
    ];
    expect(refused(withScore(9.5, { projects })).reasons).toEqual(["Điểm 9.5 < ngưỡng 9.7."]);
  });

  it("điểm đúng bằng ngưỡng thì đạt", () => {
    expect(decide(withScore(9)).approve).toBe(true);
  });

  it("hạn thu hồi là số giờ lớn nhất của chế độ và các dự án; dự án ngắn hơn không rút ngắn", () => {
    const longer = [{ key: "web-shop", autoApprove: projectAuto({ revokeHours: 72 }) }];
    expect(decide(base({ projects: longer }))).toMatchObject({ approve: true, revokeHours: 72 });
    const shorter = [{ key: "web-shop", autoApprove: projectAuto({ revokeHours: 2 }) }];
    expect(decide(base({ projects: shorter }))).toMatchObject({ approve: true, revokeHours: 24 });
  });

  it("nhiều điều kiện chất lượng trượt cùng lúc: báo đủ để người duyệt sửa một lần", () => {
    const ai = {
      reviewers: [{ cli: "claude", model: "claude-sonnet-5-5", score: 7 }],
      worstFinding: "major" as const,
      failedChecks: ["Có rủi ro"],
    };
    const d = refused(base({ ai, changedText: "đổi mật khẩu" }));
    expect(d.reasons).toHaveLength(5);
  });
});
