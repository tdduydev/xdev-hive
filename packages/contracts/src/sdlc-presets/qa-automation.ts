import { sdlcMode } from "../sdlc.ts";

const root = "qa/{NNN}-{slug}";
const common = `Chỉ ghi tài liệu của bước, không sửa code hay commit. Không ghi log, code, URL, tài khoản hay bí mật
lên hub. Dùng mã FR/AC và TC để truy vết. Thiếu thông tin thì gọi sdlc_ask.
{idea}
{artifacts}
{answers}
{feedback}`;

function document(id: string, name: string, sections: string[], template?: string) {
  return {
    id,
    name: `${id}.md`,
    path: `${root}/${id}.md`,
    sections,
    template: template ?? `# ${name}\n\n${sections.map((s) => `## ${s}\n\n…`).join("\n\n")}\n`,
  };
}
function gate(sections: string[], extra: string[] = []) {
  return [
    {
      name: "Duyệt tài liệu QA",
      gates: [
        {
          id: "rules",
          name: "Kiểm quy tắc",
          kind: "rule",
          rules: ["sections", "no-open-questions", ...extra],
          sections,
        },
        {
          id: "lead",
          name: "Người có quyền của đội duyệt",
          kind: "human",
          reviewers: { users: [], roles: ["team-admin"], quorum: 1 },
          slaHours: 48,
        },
      ],
    },
  ];
}
const scope = ["Yêu cầu nguồn", "Trong phạm vi", "Ngoài phạm vi"];
const plan = ["Phạm vi", "Cách kiểm", "Tiêu chí đạt"];
const cases = ["Test case"];
const report = ["Tóm tắt", "Kết quả TC"];

export const qaAutomation = sdlcMode.parse({
  id: "qa-automation",
  name: "Tự động hoá QA",
  method: "hive",
  profile: "qa",
  sizes: ["S", "M", "L", "XL"],
  description: "Test case gắn FR/AC; chạy trên worker hoặc desktop và duyệt QA bằng metadata kết quả.",
  phases: [
    {
      id: "scope",
      name: "Phạm vi kiểm thử",
      kind: "intake",
      artifacts: [document("scope", "Phạm vi", scope)],
      steps: [{ id: "draft-scope", action: "draft", artifacts: ["scope"], prompt: `Viết scope.md. ${common}` }],
      gate: gate(scope),
    },
    {
      id: "plan",
      name: "Kế hoạch kiểm thử",
      kind: "requirements",
      artifacts: [document("test-plan", "Kế hoạch", plan)],
      steps: [{ id: "draft-plan", action: "draft", artifacts: ["test-plan"], prompt: `Viết test-plan.md. ${common}` }],
      gate: gate(plan),
    },
    {
      id: "cases",
      name: "Test case",
      kind: "design",
      artifacts: [
        document(
          "test-cases",
          "Test case",
          cases,
          `# Test case\n\n## Test case\n\nMỗi dòng có mã TC ổn định và FR/AC. Bắt buộc mặc định là true.\n\n` +
            `| Mã | Tiêu đề | Ưu tiên | Loại | Yêu cầu | Script | Bắt buộc |\n|---|---|---|---|---|---|---|\n` +
            `| TC-001 | Đăng nhập thành công | P1 | automated | FR-001, AC-1.1 | tests/login.spec.ts | true |\n`,
        ),
      ],
      steps: [
        {
          id: "draft-cases",
          action: "draft",
          artifacts: ["test-cases"],
          prompt: `Viết test-cases.md theo bảng. ${common}`,
        },
      ],
      gate: gate(cases, ["qa-cases"]),
    },
    {
      id: "breakdown",
      name: "Chia việc tự động hoá",
      kind: "decomposition",
      artifacts: [
        document(
          "tasks",
          "Việc",
          ["Việc tự động hoá"],
          "# Việc tự động hoá\n\n## Việc tự động hoá\n\n- [ ] T001 Viết script cho TC-001\n",
        ),
      ],
      steps: [
        {
          id: "draft-tasks",
          action: "draft",
          artifacts: ["tasks"],
          prompt: `Viết tasks.md, mỗi task nêu TC nó kiểm. ${common}`,
        },
      ],
    },
    { id: "implement", name: "Viết script tại máy", kind: "implementation", artifacts: [], steps: [] },
    {
      id: "verify",
      name: "Duyệt QA",
      kind: "verification",
      artifacts: [document("test-report", "Kết quả", report)],
      steps: [
        {
          id: "test-run",
          action: "test-run",
          artifacts: ["test-report"],
          labels: ["browser", "qa-env"],
          maxQuestions: 0,
          prompt: `Chạy bộ test trên máy hiện tại với reporter Playwright JSON hoặc JUnit XML.
Test thất bại vẫn phải gửi kết quả. Tên test chứa TC-xxx; nhiều test cùng TC được gộp theo trạng thái xấu nhất.
Chuyển stdout/stderr của runner vào file tại máy. Không in reporter gốc; chỉ dùng hive test-summary để đọc và lọc.
Chạy hive test-summary <file> [--format playwright|junit] [--commit SHA] rồi gửi JSON bằng sdlc_report kind test-results.
Không tự sửa số liệu. Ghi test-report.md chỉ gồm mã TC, trạng thái và số liệu; log, code, ảnh, trace ở lại máy.
${common}`,
        },
      ],
      gate: gate(report, ["qa-tests"]),
    },
    {
      id: "release",
      name: "Kết luận QA",
      kind: "release",
      artifacts: [document("qa-summary", "Kết luận", ["Kết luận", "Rủi ro còn lại"])],
      steps: [
        {
          id: "draft-summary",
          action: "draft",
          artifacts: ["qa-summary"],
          prompt: `Viết qa-summary.md từ metadata đã duyệt. ${common}`,
        },
      ],
      gate: gate(["Kết luận", "Rủi ro còn lại"]),
    },
  ],
  decomposition: {
    phase: "breakdown",
    artifact: "tasks",
    parser: "hive-tasks",
    granularity: "item",
    requirementId: "TC-\\d{3,5}",
    requirementSource: [{ phase: "cases", artifact: "test-cases" }],
    maxTasks: 30,
    maxChecklist: 20,
  },
  blocking: "hard",
  converge: { maxRounds: 0 },
  maxAgentRevisions: 2,
});
