import { describe, expect, it } from "vitest";
import { leaderAction } from "./leader.ts";
import {
  agentPolicy,
  agentPolicyInput,
  DEFAULT_AGENT_POLICY,
  DEFAULT_ORG_SDLC_POLICY,
  DEFAULT_SDLC_DENY_PATHS,
} from "./policies.ts";
import { defaultProjectSettings, projectSdlcSettings, projectSettings, projectSettingsPatch } from "./projects.ts";
import { DANGEROUS_PERMISSIONS, SYSTEM_ROLE_PERMISSIONS } from "./roles.ts";
import { runGateErrorData } from "./runs.ts";
import {
  checkRepoPath,
  renderRepoPath,
  type SdlcModeInput,
  sdlcAnswerInput,
  sdlcContractInput,
  sdlcDocKey,
  sdlcItemCreate,
  sdlcMode,
  sdlcModeWarnings,
  sdlcOverrideInput,
  sdlcReportInput,
  sdlcSlug,
} from "./sdlc.ts";
import { task, taskSetDependenciesInput } from "./tasks.ts";
import { teamRole } from "./tenancy.ts";
import { type ReviewGateInput, workflowInput } from "./workflows.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const errors = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.error?.issues.map((i) => i.message) ?? [];

const ai: ReviewGateInput = { id: "ai", name: "AI kiểm", kind: "ai", ai: { checks: ["Đủ mục"], passScore: 8 } };
const lead: ReviewGateInput = {
  id: "lead",
  name: "Tech lead",
  kind: "human",
  reviewers: { users: [], roles: ["team-admin"], quorum: 1 },
};
const rules: ReviewGateInput = { id: "rules", name: "Luật", kind: "rule", rules: ["sections", "no-open-questions"] };

/** Chế độ nhỏ kiểu Spec Kit: Specify → Tasks → Implement. */
function mode(patch: Partial<SdlcModeInput> = {}): SdlcModeInput {
  return {
    id: "thu",
    name: "Thử",
    method: "speckit",
    profile: "feature",
    sizes: ["M"],
    phases: [
      {
        id: "specify",
        name: "Specify",
        kind: "requirements",
        artifacts: [{ id: "spec", name: "spec.md", path: "specs/{NNN}-{slug}/spec.md" }],
        steps: [{ id: "draft", action: "draft", artifacts: ["spec"], prompt: "Viết spec từ {idea}." }],
        gate: [{ name: "Specify", gates: [rules, lead] }],
      },
      {
        id: "tasks",
        name: "Tasks",
        kind: "decomposition",
        artifacts: [
          { id: "tasks", name: "tasks.md", path: "specs/{NNN}-{slug}/tasks.md" },
          {
            id: "contract",
            name: "Contract",
            path: "specs/{NNN}-{slug}/contracts/{name}.{ext}",
            scope: "contract",
            repeatable: true,
          },
        ],
        gate: [{ name: "Tasks", gates: [ai, lead] }],
        perProjectGates: ["lead"],
        autoApprove: { gates: ["lead"], minScore: 9 },
      },
      { id: "implement", name: "Implement", kind: "implementation" },
    ],
    decomposition: {
      phase: "tasks",
      artifact: "tasks",
      parser: "speckit-tasks",
      granularity: "heading",
      requirementId: "FR-\\d{3}",
      requirementSource: [{ phase: "specify", artifact: "spec" }],
    },
    ...patch,
  };
}

describe("sdlcMode", () => {
  it("nhận chế độ hợp lệ và điền mặc định", () => {
    const m = sdlcMode.parse(mode());
    expect(m.blocking).toBe("hard");
    expect(m.maxAgentRevisions).toBe(2);
    expect(m.converge.maxRounds).toBe(0);
    expect(m.phases[1]?.autoApprove?.revokeHours).toBe(24);
    expect(m.phases[0]?.artifacts[0]).toMatchObject({ required: true, scope: "item", repeatable: false });
    expect(sdlcModeWarnings(m)).toEqual([]);
  });

  it.each([
    "../spec.md",
    "specs/../../etc/passwd",
    "/specs/spec.md",
    ".github/workflows/x.md",
    ".GitHub/Workflows/x.md",
    ".git/hooks/pre-commit",
    "docs/.git/config",
    ".gitlab-ci.yml",
    "specs//spec.md",
    "specs/{NNN}/{owner}.md",
    "specs/{name}.md",
  ])("từ chối đường dẫn %s", (path) => {
    const m = mode();
    const phase = m.phases[0];
    if (!phase) throw new Error("thiếu giai đoạn");
    const bad = {
      ...m,
      phases: [{ ...phase, artifacts: [{ id: "spec", name: "spec.md", path }] }, ...m.phases.slice(1)],
    };
    expect(sdlcMode.safeParse(bad).success).toBe(false);
  });

  it("checkRepoPath: biến {name}, {ext} chỉ cho contract; .github ngoài workflows được", () => {
    expect(checkRepoPath("specs/{NNN}-{slug}/contracts/{name}.{ext}", { contract: true })).toBeNull();
    expect(checkRepoPath("specs/{NNN}-{slug}/contracts/{name}.{ext}")).toMatch(/^Biến trong đường dẫn/);
    expect(checkRepoPath(".github/ISSUE_TEMPLATE/bug.md")).toBeNull();
    expect(checkRepoPath("aidlc/spaces/default/intents/{date}-{slug}/requirements.md")).toBeNull();
  });

  it("từ chối tham chiếu sai và id trùng", () => {
    const m = mode();
    const [specify, tasks, impl] = m.phases;
    if (!specify || !tasks || !impl) throw new Error("thiếu giai đoạn");
    const cases: [SdlcModeInput, string][] = [
      [
        {
          ...m,
          phases: [
            { ...specify, steps: [{ id: "d", action: "draft", artifacts: ["plan"], prompt: "x" }] },
            tasks,
            impl,
          ],
        },
        "Bước “d” trỏ tới tài liệu “plan” không có.",
      ],
      [{ ...m, phases: [specify, { ...tasks, id: "specify" }, impl] }, "Mã giai đoạn “specify” trùng."],
      [
        { ...m, phases: [specify, { ...tasks, artifacts: [{ id: "spec", name: "x", path: "x.md" }] }, impl] },
        "Mã tài liệu “spec” trùng.",
      ],
      [
        { ...m, decomposition: { ...(m.decomposition as object), artifact: "spec" } as SdlcModeInput["decomposition"] },
        "Tài liệu tách việc “spec” không thuộc giai đoạn “tasks”.",
      ],
      [
        {
          ...m,
          decomposition: { ...(m.decomposition as object), requirementId: "FR-(" } as SdlcModeInput["decomposition"],
        },
        "Mẫu mã requirement không phải regex hợp lệ.",
      ],
      [
        { ...m, phases: [specify, { ...tasks, perProjectGates: ["ai"] }, impl] },
        "Cổng theo dự án “ai” phải là checkpoint người duyệt của giai đoạn.",
      ],
      [{ ...m, phases: [specify, impl, tasks] }, "Tài liệu tách việc phải ở giai đoạn trước giai đoạn triển khai."],
      [
        {
          ...m,
          phases: [
            {
              ...specify,
              gate: [
                { name: "Specify", gates: [{ ...lead, reviewers: { roles: ["team-admin"], teamScope: uuid(1) } }] },
              ],
            },
            tasks,
            impl,
          ],
        },
        "Đội của người duyệt do hub điền, không đặt trong chế độ.",
      ],
    ];
    for (const [input, message] of cases) expect(errors(sdlcMode.safeParse(input))).toContain(message);
  });

  it("contract phải lặp được, tài liệu khác không lặp", () => {
    const m = mode();
    const [specify, tasks, impl] = m.phases;
    if (!specify || !tasks || !impl) throw new Error("thiếu giai đoạn");
    const noRepeat = {
      ...tasks,
      artifacts: [
        { id: "tasks", name: "tasks.md", path: "t.md" },
        { id: "c", name: "c", path: "c/{name}.{ext}", scope: "contract" as const },
      ],
    };
    expect(errors(sdlcMode.safeParse({ ...m, phases: [specify, noRepeat, impl] }))).toContain(
      "Contract phải lặp được (mỗi hạng mục 0..n contract).",
    );
    const repeatSpec = { ...specify, artifacts: [{ id: "spec", name: "s", path: "s.md", repeatable: true }] };
    expect(errors(sdlcMode.safeParse({ ...m, phases: [repeatSpec, tasks, impl] }))).toContain(
      "Chỉ contract mới lặp được.",
    );
  });

  it("cảnh báo chặn cứng không có tài liệu bắt buộc", () => {
    const m = sdlcMode.parse({
      ...mode(),
      phases: [{ id: "implement", name: "Implement", kind: "implementation" }],
      decomposition: null,
    });
    expect(sdlcModeWarnings(m)).toEqual(["Chặn cứng không có tác dụng: chưa có tài liệu bắt buộc."]);
  });
});

describe("tự duyệt ở chế độ (FR-056)", () => {
  const withAuto = (phaseIndex: number, autoApprove: unknown, sizes: SdlcModeInput["sizes"] = ["M"]) => {
    const m = mode({ sizes });
    const phases = m.phases.map((p, i) =>
      i === phaseIndex ? { ...p, autoApprove } : { ...p, autoApprove: undefined },
    );
    return errors(sdlcMode.safeParse({ ...m, phases }));
  };

  it("nhận cổng người có checkpoint AI đứng trước và ngưỡng ≥ điểm đạt", () => {
    expect(withAuto(1, { gates: ["lead"], minScore: 8 })).toEqual([]);
  });

  it("từ chối cổng không phải người duyệt", () => {
    expect(withAuto(1, { gates: ["ai"], minScore: 9 })).toEqual([
      "Chỉ tự duyệt được checkpoint người duyệt; “AI kiểm” không phải.",
    ]);
  });

  it("từ chối khi không có checkpoint AI trước cổng", () => {
    expect(withAuto(0, { gates: ["lead"], minScore: 9 })).toEqual([
      "Cần checkpoint AI trước “Tech lead” để có điểm tự duyệt.",
    ]);
  });

  it("từ chối ngưỡng thấp hơn passScore của checkpoint AI", () => {
    expect(withAuto(1, { gates: ["lead"], minScore: 7.5 })).toEqual([
      "Ngưỡng tự duyệt không được thấp hơn điểm đạt 8 của checkpoint AI.",
    ]);
  });

  it("từ chối giai đoạn requirements của chế độ nặng, nhận ở chế độ nhẹ", () => {
    const m = mode();
    const [specify, tasks, impl] = m.phases;
    if (!specify || !tasks || !impl) throw new Error("thiếu giai đoạn");
    const gated = {
      ...specify,
      gate: [{ name: "Specify", gates: [ai, lead] }],
      autoApprove: { gates: ["lead"], minScore: 9 },
    };
    const heavy = errors(sdlcMode.safeParse({ ...m, sizes: ["M", "L"], phases: [gated, tasks, impl] }));
    expect(heavy).toEqual(["Giai đoạn yêu cầu của chế độ nặng luôn cần người duyệt."]);
    expect(errors(sdlcMode.safeParse({ ...m, sizes: ["S"], phases: [gated, tasks, impl] }))).toEqual([]);
  });

  it("từ chối cổng không có trong giai đoạn", () => {
    expect(withAuto(1, { gates: ["po"], minScore: 9 })).toEqual(["Không có checkpoint “po” trong cổng của giai đoạn."]);
  });
});

describe("cài đặt dự án và chính sách tổ chức", () => {
  it("dự án cũ không có mục sdlc vẫn parse; mục sdlc rỗng là tắt", () => {
    const old = defaultProjectSettings();
    expect(projectSettings.parse(old).sdlc).toBeUndefined();
    const s = projectSdlcSettings.parse({});
    expect(s).toMatchObject({ enabled: false, repoSync: "pr", maxParallel: 2, runner: "team", labels: [] });
    expect(s.autoApprove).toEqual({ enabled: false, denyPaths: [], denyKeywords: [] });
  });

  it("kiểm nhãn, song song, thư mục tài liệu", () => {
    expect(projectSdlcSettings.safeParse({ labels: ["SDLC"] }).success).toBe(false);
    expect(projectSdlcSettings.safeParse({ labels: ["sdlc", "gpu-1"] }).success).toBe(true);
    expect(projectSdlcSettings.safeParse({ maxParallel: 11 }).success).toBe(false);
    expect(projectSdlcSettings.safeParse({ docsRoot: "../docs" }).success).toBe(false);
    expect(projectSdlcSettings.safeParse({ autoApprove: { enabled: true, revokeHours: 200 } }).success).toBe(false);
  });

  it("bản vá thay cả mục sdlc và không nhận khoá gõ sai", () => {
    expect(projectSettingsPatch.parse({ sdlc: { enabled: true } }).sdlc?.enabled).toBe(true);
    expect(projectSettingsPatch.safeParse({ sdlc: { enabld: true } }).success).toBe(false);
  });

  it("chính sách cũ không có sdlc vẫn parse; mặc định của tổ chức có danh sách nhạy cảm", () => {
    const input = agentPolicyInput.parse(DEFAULT_AGENT_POLICY);
    expect(input.sdlc).toBeUndefined();
    const out = agentPolicy.parse({
      ...DEFAULT_AGENT_POLICY,
      updatedAt: null,
      updatedBy: null,
      templateSync: null,
      defaultTemplates: { agents: "", claude: "", mcp: "" },
    });
    expect(out.sdlc).toBeUndefined();
    expect(DEFAULT_ORG_SDLC_POLICY.autoApprove).toMatchObject({ allowed: true, minScoreFloor: 8 });
    expect(DEFAULT_ORG_SDLC_POLICY.autoApprove.denyPaths).toEqual(DEFAULT_SDLC_DENY_PATHS);
    expect(DEFAULT_ORG_SDLC_POLICY.autoApprove.denyKeywords).toContain("thanh toán");
    const saved = agentPolicyInput.parse({ ...DEFAULT_AGENT_POLICY, sdlc: { autoApprove: { allowed: false } } });
    expect(saved.sdlc?.autoApprove).toMatchObject({ allowed: false, minScoreFloor: 8 });
  });
});

describe("hạng mục", () => {
  const base = {
    projectId: uuid(1),
    title: "Hoàn tiền một phần",
    idea: "Cho phép hoàn tiền một phần cho đơn đã giao.",
    modeRef: "speckit",
    size: "M",
  };

  it("nhận dự án tham gia, từ chối trùng và quá 8 dự án", () => {
    expect(sdlcItemCreate.parse(base).participants).toEqual([]);
    expect(sdlcItemCreate.safeParse({ ...base, participants: [uuid(2), uuid(3)] }).success).toBe(true);
    expect(sdlcItemCreate.safeParse({ ...base, participants: [uuid(1)] }).success).toBe(false);
    expect(sdlcItemCreate.safeParse({ ...base, participants: [uuid(2), uuid(2)] }).success).toBe(false);
    const many = Array.from({ length: 8 }, (_, i) => uuid(i + 2));
    expect(sdlcItemCreate.safeParse({ ...base, participants: many }).success).toBe(false);
    expect(sdlcItemCreate.safeParse({ ...base, idea: "ngắn" }).success).toBe(false);
  });

  it("contract: bên cung cấp không là bên dùng", () => {
    const c = { itemId: uuid(1), name: "refund-api", format: "openapi", providerProjectId: uuid(2) };
    expect(sdlcContractInput.safeParse({ ...c, consumerProjectIds: [uuid(3)] }).success).toBe(true);
    expect(sdlcContractInput.safeParse({ ...c, consumerProjectIds: [uuid(2)] }).success).toBe(false);
    expect(sdlcContractInput.safeParse({ ...c, consumerProjectIds: [] }).success).toBe(false);
  });

  it("ngoại lệ cần lý do ≥ 10 ký tự và một phạm vi", () => {
    expect(sdlcOverrideInput.safeParse({ itemId: uuid(1), reason: "Hotfix khách hàng A" }).success).toBe(true);
    expect(errors(sdlcOverrideInput.safeParse({ itemId: uuid(1), reason: "gấp" }))).toEqual([
      "Lý do ngoại lệ cần ít nhất 10 ký tự.",
    ]);
    const both = { itemId: uuid(1), taskId: uuid(2), projectId: uuid(3), reason: "Hotfix khách hàng A" };
    expect(sdlcOverrideInput.safeParse(both).success).toBe(false);
  });

  it("trả lời câu hỏi: hoặc chữ, hoặc dùng đề xuất", () => {
    const ok = {
      itemId: uuid(1),
      answers: [
        { id: uuid(2), answer: "Có" },
        { id: uuid(3), useRecommended: true },
      ],
    };
    expect(sdlcAnswerInput.safeParse(ok).success).toBe(true);
    const bad = { itemId: uuid(1), answers: [{ id: uuid(2), answer: "Có", useRecommended: true }] };
    expect(sdlcAnswerInput.safeParse(bad).success).toBe(false);
    expect(sdlcAnswerInput.safeParse({ itemId: uuid(1), answers: [{ id: uuid(2) }] }).success).toBe(false);
  });

  it("sdlc_report contracts theo key dự án", () => {
    const report = {
      kind: "contracts",
      data: {
        contracts: [
          {
            name: "refund-api",
            format: "openapi",
            provider: "payment-api",
            consumers: ["web-shop"],
            content: "openapi: 3.1.0",
          },
        ],
      },
    };
    expect(sdlcReportInput.safeParse(report).success).toBe(true);
    expect(sdlcReportInput.safeParse({ kind: "size", data: { size: "XXL", modeRef: "x", reason: "" } }).success).toBe(
      false,
    );
  });

  it("leader đề xuất tạo hạng mục", () => {
    const action = leaderAction.parse({ type: "sdlc.item.create", item: base });
    expect(action.type === "sdlc.item.create" && action.item.participants).toEqual([]);
  });
});

describe("đường dẫn, slug, key tài liệu", () => {
  it("sdlcSlug bỏ dấu và cắt ở gạch ngang", () => {
    expect(sdlcSlug("Cho phép hoàn tiền một phần cho đơn đã giao")).toBe("cho-phep-hoan-tien-mot-phan-cho-don-da-giao");
    expect(sdlcSlug("Đổi mật khẩu — bước 2!")).toBe("doi-mat-khau-buoc-2");
    expect(sdlcSlug("Hoàn tiền một phần cho đơn đã giao", 20)).toBe("hoan-tien-mot-phan");
    expect(sdlcSlug("???")).toBe("hang-muc");
  });

  it("renderRepoPath điền biến; repo tham gia mang key dự án chính", () => {
    const vars = { number: 12, slug: "hoan-tien", date: "2026-10-13" };
    expect(renderRepoPath("specs/{NNN}-{slug}/spec.md", vars)).toBe("specs/012-hoan-tien/spec.md");
    expect(renderRepoPath("specs/{NNN}-{slug}/spec.md", { ...vars, homeKey: "payment-api" })).toBe(
      "specs/payment-api-012-hoan-tien/spec.md",
    );
    expect(renderRepoPath("intents/{date}-{slug}/r.md", vars)).toBe("intents/2026-10-13-hoan-tien/r.md");
    expect(
      renderRepoPath("specs/{NNN}-{slug}/contracts/{name}.{ext}", { ...vars, name: "refund-api", format: "openapi" }),
    ).toBe("specs/012-hoan-tien/contracts/refund-api.yaml");
  });

  it("sdlcDocKey theo phạm vi (D20, D23)", () => {
    const base = { homeKey: "payment-api", number: 12, slug: "hoan-tien" };
    expect(sdlcDocKey({ ...base, artifactId: "spec", scope: "item" })).toBe(
      "project/payment-api/sdlc/012-hoan-tien/spec",
    );
    expect(sdlcDocKey({ ...base, artifactId: "plan", scope: "project", instance: "web-shop" })).toBe(
      "project/web-shop/sdlc/payment-api-012-hoan-tien/plan",
    );
    expect(sdlcDocKey({ ...base, artifactId: "plan", scope: "project", instance: "payment-api" })).toBe(
      "project/payment-api/sdlc/012-hoan-tien/plan",
    );
    expect(sdlcDocKey({ ...base, artifactId: "contract", scope: "contract", instance: "refund-api" })).toBe(
      "project/payment-api/sdlc/012-hoan-tien/contracts/refund-api",
    );
  });
});

describe("vai trò và quyền (FR-061, D27)", () => {
  it("team-ba có đúng quyền soạn và duyệt tài liệu", () => {
    expect([...SYSTEM_ROLE_PERMISSIONS["team-ba"]].sort()).toEqual(
      // leader.terminal: BA/PO mở terminal Leader của dự án đội mình (FR-067). qa.read: xem kiểm thử (specs/036 FR-014).
      [
        "docs.read",
        "leader.terminal",
        "proposals.create",
        "qa.read",
        "runs.read",
        "sdlc.read",
        "sdlc.write",
        "tasks.read",
      ].sort(),
    );
    expect(teamRole.parse("ba")).toBe("ba");
  });

  it("người xem đọc, thành viên viết, quản trị đội cho ngoại lệ", () => {
    expect(SYSTEM_ROLE_PERMISSIONS["team-viewer"]).toContain("sdlc.read");
    expect(SYSTEM_ROLE_PERMISSIONS["team-viewer"]).not.toContain("sdlc.write");
    expect(SYSTEM_ROLE_PERMISSIONS["team-member"]).toContain("sdlc.write");
    expect(SYSTEM_ROLE_PERMISSIONS["team-member"]).not.toContain("sdlc.override");
    expect(SYSTEM_ROLE_PERMISSIONS["team-admin"]).toEqual(
      expect.arrayContaining(["sdlc.override", "sdlc.modes.write"]),
    );
    expect(SYSTEM_ROLE_PERMISSIONS.admin).toContain("sdlc.override");
    expect(DANGEROUS_PERMISSIONS).toContain("sdlc.override");
  });
});

describe("task và run", () => {
  it("task cũ không có checklist, phụ thuộc vẫn parse", () => {
    const t = task.parse({
      id: uuid(1),
      projectId: uuid(2),
      teamId: uuid(3),
      key: "pay-1",
      number: 1,
      title: "x",
      body: "",
      type: null,
      status: "todo",
      preferredCli: null,
      source: {},
      createdBy: "u",
      createdAt: "2026-10-13T00:00:00.000Z",
      updatedAt: "2026-10-13T00:00:00.000Z",
    });
    expect(t.checklist).toBeUndefined();
  });

  it("setDependencies bỏ trùng, từ chối tự phụ thuộc", () => {
    expect(taskSetDependenciesInput.parse({ taskId: uuid(1), dependsOn: [uuid(2), uuid(2)] }).dependsOn).toEqual([
      uuid(2),
    ]);
    expect(errors(taskSetDependenciesInput.safeParse({ taskId: uuid(1), dependsOn: [uuid(1)] }))).toEqual([
      "Task không phụ thuộc chính nó.",
    ]);
  });

  it("lỗi chặn run mang danh sách tài liệu thiếu", () => {
    const data = {
      code: "SDLC_GATE_BLOCKED",
      missing: [
        {
          kind: "artifact",
          docKey: "project/p/sdlc/012-x/plan",
          name: "plan.md (Plan)",
          phase: "Plan",
          reason: "no_baseline",
        },
      ],
    };
    expect(runGateErrorData.parse(data)).toEqual(data);
  });
});

describe("quy trình duyệt", () => {
  const doc = {
    name: "Spec",
    preset: "custom",
    teamId: null,
    docPrefixes: ["project/pay/"],
    phases: [{ name: "Duyệt", gates: [{ ...lead, reviewers: { roles: ["team-ba"] } }, rules] }],
    enabled: true,
  };

  it("nhận vai trò team-ba và luật mới cho tài liệu", () => {
    expect(workflowInput.safeParse(doc).success).toBe(true);
  });

  it("không cho người sửa đặt teamScope", () => {
    const scoped = {
      ...doc,
      phases: [{ name: "Duyệt", gates: [{ ...lead, reviewers: { roles: ["team-admin"], teamScope: uuid(1) } }] }],
    };
    expect(errors(workflowInput.safeParse(scoped))).toContain(
      "Đội của người duyệt do hub điền, không đặt trong quy trình.",
    );
  });

  it("luật của tài liệu hạng mục không dùng cho code", () => {
    const code = {
      ...doc,
      subject: "code",
      docPrefixes: [],
      code: {},
      phases: [{ name: "Luật", gates: [{ id: "r", name: "r", kind: "rule", rules: ["coverage"] }] }],
    };
    expect(errors(workflowInput.safeParse(code))).toContain("Quy tắc này chỉ dùng cho tài liệu.");
  });
});
