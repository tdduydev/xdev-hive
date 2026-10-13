import { sdlcMode } from "../sdlc.ts";

/**
 * Preset `aidlc-express`: yêu cầu đã rõ, cỡ M. Tham khảo cách chia của AI-DLC (AWS): inception ghi yêu cầu, construction
 * làm và kiểm, thư mục record theo ý định (intent). Bản Express bỏ Unit và Bolt nên cả hạng mục là một task. Khuôn và
 * prompt do Hive tự viết; chỉ đường dẫn thư mục theo quy ước của AI-DLC để công cụ AI-DLC trong repo đọc được.
 */

const REQUIREMENTS_PATH = "aidlc/spaces/default/intents/{date}-{slug}/inception/requirements-analysis/requirements.md";
const TEST_RESULTS_PATH = "aidlc/spaces/default/intents/{date}-{slug}/construction/build-and-test/test-results.md";

const REQUIREMENT_SECTIONS = ["Ý định", "Phạm vi", "Yêu cầu chức năng", "Yêu cầu phi chức năng", "Giả định"];

const REQUIREMENTS_TEMPLATE = `# Phân tích yêu cầu

## Ý định

Một đoạn: ai cần gì, vì sao bây giờ.

## Phạm vi

Trong phạm vi:

- …

Ngoài phạm vi:

- …

## Yêu cầu chức năng

- **REQ-001**: Hệ thống phải …
  - Tiêu chí chấp nhận: Khi … thì …
- **REQ-002**: Hệ thống phải …
  - Tiêu chí chấp nhận: Khi … thì …

## Yêu cầu phi chức năng

- **REQ-101**: Hiệu năng, bảo mật, khả năng truy cập… nếu có.
  - Tiêu chí chấp nhận: …

## Giả định

Điều đang coi là đúng khi chưa có câu trả lời, và ai xác nhận.
`;

const TEST_RESULTS_TEMPLATE = `# Kết quả build và test

## Lệnh đã chạy

- \`…\`: kết quả.

## Đối chiếu yêu cầu

- REQ-001: đạt / không đạt, bằng chứng (test, PR).
`;

const DRAFT_PROMPT = `Bạn viết tài liệu yêu cầu cho một hạng mục theo cách làm của AI-DLC bản Express: đủ để chia việc và kiểm, không thêm nghi thức.

Ý tưởng của người giao:
{idea}

Bối cảnh đã có (tài liệu, câu trả lời, góp ý của người duyệt):
{artifacts}
{answers}
{feedback}

Cách làm:
1. Đọc repo trước (cấu trúc, README, code gần chỗ sẽ đổi) để yêu cầu khớp hệ thống thật, không viết chung chung.
2. Mỗi yêu cầu là một dòng \`REQ-nnn\` có tiêu chí chấp nhận kiểm được ("Khi … thì …"). Yêu cầu không kiểm được thì viết lại hoặc bỏ.
3. Tách rõ trong phạm vi và ngoài phạm vi. Điều chưa chắc nhưng không chặn việc thì ghi vào "Giả định".
4. Điều chặn việc mà repo không trả lời được thì gọi \`sdlc_ask\` (tối đa 5 câu mỗi vòng, kèm đề xuất). Chưa có
   trả lời thì để \`[NEEDS CLARIFICATION: câu hỏi]\` đúng chỗ đó, không tự quyết.
5. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

const TEST_RESULTS_PROMPT = `Bạn tổng hợp kết quả kiểm sau khi code của hạng mục đã vào nhánh mặc định.

Yêu cầu đã duyệt:
{artifacts}
{feedback}

Cách làm:
1. Chạy lệnh build và test của repo (xem README, AGENTS.md hoặc CI). Ghi lệnh thật và kết quả thật; không chạy được thì nói rõ vì sao.
2. Với mỗi \`REQ-nnn\`, ghi đạt hay không đạt kèm bằng chứng (tên test, file, PR). Không đủ bằng chứng thì ghi "chưa kiểm".
3. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

export const aidlcExpress = sdlcMode.parse({
  id: "aidlc-express",
  name: "AI-DLC Express",
  description: "Yêu cầu đã rõ, cỡ M: tài liệu yêu cầu có người duyệt (PO), một task, kiểm kết quả sau khi merge.",
  method: "aidlc",
  profile: "express",
  sizes: ["M"],
  phases: [
    {
      id: "requirements",
      name: "Yêu cầu",
      kind: "requirements",
      artifacts: [
        {
          id: "requirements",
          name: "requirements.md",
          path: REQUIREMENTS_PATH,
          sections: REQUIREMENT_SECTIONS,
          template: REQUIREMENTS_TEMPLATE,
        },
      ],
      steps: [{ id: "draft-requirements", action: "draft", artifacts: ["requirements"], prompt: DRAFT_PROMPT }],
      gate: [
        {
          name: "Duyệt yêu cầu",
          outputs: ["requirements.md"],
          gates: [
            {
              id: "rules",
              name: "Đủ mục, mỗi yêu cầu có tiêu chí, hết câu hỏi mở",
              kind: "rule",
              rules: ["sections", "requirements", "no-open-questions"],
              sections: REQUIREMENT_SECTIONS,
            },
            {
              id: "po",
              name: "PO duyệt yêu cầu",
              kind: "human",
              reviewers: { users: [], roles: ["team-ba", "team-admin"], quorum: 1 },
              slaHours: 24,
            },
          ],
        },
      ],
      // Yêu cầu nên để người quyết; dự án muốn tự duyệt thì nhân bản chế độ này và thêm checkpoint AI.
      perProjectGates: ["po"],
    },
    { id: "implement", name: "Triển khai", kind: "implementation" },
    {
      id: "verify",
      name: "Kiểm",
      kind: "verification",
      optional: true,
      artifacts: [
        {
          id: "test-results",
          name: "test-results.md",
          path: TEST_RESULTS_PATH,
          required: false,
          template: TEST_RESULTS_TEMPLATE,
        },
      ],
      steps: [
        {
          id: "draft-test-results",
          action: "draft",
          artifacts: ["test-results"],
          auto: false,
          prompt: TEST_RESULTS_PROMPT,
        },
      ],
    },
  ],
  // Express không có Unit: cả hạng mục là một task, checklist lấy từ các REQ-nnn.
  decomposition: {
    phase: "requirements",
    artifact: "requirements",
    parser: "aidlc-units",
    granularity: "single",
    requirementId: "REQ-\\d+",
    requirementSource: [{ phase: "requirements", artifact: "requirements" }],
    maxTasks: 1,
    maxChecklist: 20,
  },
  blocking: "hard",
  converge: { maxRounds: 0 },
  maxAgentRevisions: 2,
});
