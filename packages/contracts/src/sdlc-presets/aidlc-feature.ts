import { sdlcMode } from "../sdlc.ts";

/**
 * Preset `aidlc-feature`: tính năng production, cỡ L. Theo các pha của AI-DLC (AWS): Ideation chốt ý định, Inception
 * viết yêu cầu, thiết kế và chia Unit, Construction làm theo Unit, Operation viết runbook và release notes. Mỗi Unit là
 * một task hub (một PR). Khuôn và prompt do Hive viết; đường dẫn theo thư mục record của AI-DLC để công cụ AI-DLC trong
 * repo đọc được. `aidlc-enterprise` dùng lại các phần ở đây.
 */

export const AIDLC_RECORD = "aidlc/spaces/default/intents/{date}-{slug}";

export const AIDLC_PO = { users: [], roles: ["team-ba", "team-admin"], quorum: 1 };
export const AIDLC_LEAD = { users: [], roles: ["team-admin"], quorum: 1 };

export const INTENT_SECTIONS = ["Ý định", "Người dùng", "Thước đo thành công", "Phạm vi"];
export const REQUIREMENT_SECTIONS = ["Ý định", "Phạm vi", "Yêu cầu chức năng", "Yêu cầu phi chức năng", "Giả định"];
export const DESIGN_SECTIONS = ["Thành phần", "Luồng dữ liệu", "Giao tiếp giữa thành phần", "Rủi ro"];
export const UNITS_SECTIONS = ["Units of Work"];

const INTENT_TEMPLATE = `# Ý định

## Ý định

Một đoạn: vấn đề gì, của ai, vì sao làm bây giờ.

## Người dùng

- Ai dùng, họ đang làm thế nào khi chưa có tính năng.

## Thước đo thành công

- Số đo được sau khi phát hành (ví dụ: tỉ lệ hoàn tiền tự phục vụ ≥ 60%).

## Phạm vi

Trong phạm vi:

- …

Ngoài phạm vi:

- …
`;

export const REQUIREMENTS_TEMPLATE = `# Phân tích yêu cầu

## Ý định

Tóm tắt ý định đã duyệt.

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

const STORIES_TEMPLATE = `# User stories

## Story: …

As a …, I want …, so that …

- Yêu cầu: REQ-001
- Tiêu chí chấp nhận: Given … when … then …
`;

const COMPONENTS_TEMPLATE = `# Thiết kế ứng dụng

## Thành phần

| Thành phần | Trách nhiệm | Repo, thư mục |
|---|---|---|
| … | … | … |

## Luồng dữ liệu

Đường đi của dữ liệu cho từng yêu cầu chính.

## Giao tiếp giữa thành phần

API, sự kiện, bảng dùng chung. Giao tiếp giữa hai repo thì viết thành contract riêng.

## Rủi ro

- Rủi ro, cách giảm.
`;

const DECISIONS_TEMPLATE = `# Quyết định thiết kế

## QĐ-1: …

- Bối cảnh: …
- Lựa chọn đã xét: …
- Quyết định và lý do: …
`;

export const UNITS_TEMPLATE = `# Units of Work

## Unit 1: …

Phạm vi: phần việc giao được cho một run và một PR (REQ-001).

- [ ] Việc cụ thể, nêu file sẽ đổi
- [ ] Test cho việc trên

## Unit 2: …

Phụ thuộc: Unit 1

- [ ] …
`;

const UNIT_DEPENDENCY_TEMPLATE = `# Phụ thuộc giữa các Unit

| Unit | Cần Unit | Lý do |
|---|---|---|
| Unit 2 | Unit 1 | … |
`;

const BOLT_PLAN_TEMPLATE = `# Kế hoạch Bolt

## Bolt 1

- Unit: Unit 1
- Mục tiêu: …
- Cách kiểm: …
`;

const TEST_RESULTS_TEMPLATE = `# Kết quả build và test

## Lệnh đã chạy

- \`…\`: kết quả.

## Đối chiếu yêu cầu

- REQ-001: đạt / không đạt, bằng chứng (test, PR).
`;

const RUNBOOK_TEMPLATE = `# Runbook

## Triển khai

Các bước, cờ tính năng, migration.

## Theo dõi

Chỉ số, cảnh báo cần xem sau khi phát hành.

## Quay lui

Cách quay lui và dữ liệu cần giữ.
`;

const RELEASE_NOTES_TEMPLATE = `# Release notes

## Thay đổi

- …

## Ảnh hưởng tới người dùng

- …
`;

const CONTEXT = `Bối cảnh đã có (tài liệu, câu trả lời, góp ý của người duyệt):
{artifacts}
{answers}
{feedback}`;

const ASK = `Điều chặn việc mà repo không trả lời được thì gọi \`sdlc_ask\` (kèm đề xuất). Chưa có trả lời thì để
\`[NEEDS CLARIFICATION: câu hỏi]\` đúng chỗ đó, không tự quyết. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

export const INTENT_PROMPT = `Bạn viết tài liệu ý định (Ideation của AI-DLC) cho một hạng mục.

Ý tưởng của người giao:
{idea}

${CONTEXT}

Cách làm:
1. Đọc repo để biết hệ thống đang làm được gì, tránh đề xuất cái đã có.
2. Nêu rõ người dùng, thước đo thành công đo được và ranh giới phạm vi. Không viết giải pháp kỹ thuật ở đây.
3. ${ASK}`;

export const REQUIREMENTS_PROMPT = `Bạn viết tài liệu yêu cầu và user story (Inception của AI-DLC) từ ý định đã duyệt.

Ý tưởng của người giao:
{idea}

${CONTEXT}

Cách làm:
1. Đọc repo (cấu trúc, README, code gần chỗ sẽ đổi) để yêu cầu khớp hệ thống thật.
2. Mỗi yêu cầu là một dòng \`REQ-nnn\` có tiêu chí chấp nhận kiểm được. Yêu cầu phi chức năng đánh số từ REQ-101.
3. Mỗi story trong stories.md trỏ về ít nhất một REQ-nnn.
4. ${ASK}`;

export const DESIGN_PROMPT = `Bạn viết thiết kế ứng dụng (Inception của AI-DLC): thành phần, quyết định, contract giữa các repo.

Các dự án tham gia:
{projects}

${CONTEXT}

Cách làm:
1. Đọc code thật của từng repo tham gia; thiết kế tái dùng cái có sẵn.
2. Mỗi quyết định có lựa chọn đã xét và lý do. Mọi REQ-nnn phải có thành phần nhận.
3. Giao tiếp giữa hai repo viết thành contract riêng (\`contracts/<tên>.<đuôi>\`), bên cung cấp và bên dùng rõ ràng.
4. ${ASK}`;

export const UNITS_PROMPT = `Bạn chia thiết kế đã duyệt thành Unit of Work (Inception của AI-DLC). Mỗi Unit là một task của hub: một run, một PR.

Các dự án tham gia:
{projects}

${CONTEXT}

Cách làm:
1. Mỗi Unit là một mục \`## Unit N: Tên\`. Unit làm ở repo khác dự án chính thì thêm dòng \`Dự án: <khoá>\` ngay dưới.
2. Ghi \`Phụ thuộc: Unit 1, Unit 2\` khi Unit cần Unit khác xong trước. Không tạo phụ thuộc vòng.
3. Dưới mỗi Unit là checklist \`- [ ] …\` nêu file cụ thể; mỗi Unit nhắc REQ-nnn nó phủ. Mọi REQ-nnn phải có Unit.
4. unit-of-work-dependency.md và bolt-plan.md giải thích thứ tự; phụ thuộc thật vẫn phải nằm trong unit-of-work.md.
5. ${ASK}`;

export const TEST_RESULTS_PROMPT = `Bạn tổng hợp kết quả kiểm sau khi code của các Unit đã vào nhánh mặc định.

${CONTEXT}

Cách làm:
1. Chạy lệnh build và test của repo (xem README, AGENTS.md hoặc CI). Ghi lệnh thật và kết quả thật.
2. Với mỗi \`REQ-nnn\`, ghi đạt hay không đạt kèm bằng chứng. Không đủ bằng chứng thì ghi "chưa kiểm".
3. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

export const OPERATION_PROMPT = `Bạn viết runbook và release notes (Operation của AI-DLC) cho hạng mục đã xong.

${CONTEXT}

Cách làm:
1. Đọc các PR đã merge và tài liệu đã duyệt; chỉ ghi thay đổi có thật.
2. Runbook nêu bước triển khai, chỉ số cần theo dõi và cách quay lui.
3. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

export const AI_REQUIREMENTS_CHECKS = [
  "Mỗi yêu cầu có mã REQ-nnn và tiêu chí chấp nhận kiểm được",
  "Yêu cầu khớp ý định và phạm vi đã duyệt",
  "Mỗi story trỏ về yêu cầu có thật",
];
export const AI_DESIGN_CHECKS = [
  "Mọi yêu cầu REQ-nnn có thành phần nhận",
  "Quyết định có lựa chọn đã xét và lý do",
  "Giao tiếp giữa các repo đã thành contract",
];
export const AI_UNITS_CHECKS = [
  "Mỗi Unit giao được cho một run và một PR",
  "Thứ tự và phụ thuộc giữa các Unit hợp lý",
  "Checklist nêu file cụ thể và có test",
];

export const intentArtifact = {
  id: "intent",
  name: "intent.md",
  path: `${AIDLC_RECORD}/ideation/intent.md`,
  sections: INTENT_SECTIONS,
  template: INTENT_TEMPLATE,
};
export const requirementsArtifact = {
  id: "requirements",
  name: "requirements.md",
  path: `${AIDLC_RECORD}/inception/requirements-analysis/requirements.md`,
  sections: REQUIREMENT_SECTIONS,
  template: REQUIREMENTS_TEMPLATE,
};
export const storiesArtifact = {
  id: "stories",
  name: "stories.md",
  path: `${AIDLC_RECORD}/inception/user-stories/stories.md`,
  required: false,
  template: STORIES_TEMPLATE,
};
export const designArtifacts = [
  {
    id: "components",
    name: "components.md",
    path: `${AIDLC_RECORD}/inception/application-design/components.md`,
    sections: DESIGN_SECTIONS,
    template: COMPONENTS_TEMPLATE,
  },
  {
    id: "decisions",
    name: "decisions.md",
    path: `${AIDLC_RECORD}/inception/application-design/decisions.md`,
    required: false,
    template: DECISIONS_TEMPLATE,
  },
  // Hai đội phải đồng ý trước khi cùng cài đặt (D23).
  {
    id: "contract",
    name: "Contract liên repo",
    path: `${AIDLC_RECORD}/inception/application-design/contracts/{name}.{ext}`,
    required: false,
    scope: "contract" as const,
    repeatable: true,
  },
];
export const unitsArtifacts = [
  {
    id: "units",
    name: "unit-of-work.md",
    path: `${AIDLC_RECORD}/inception/units-generation/unit-of-work.md`,
    sections: UNITS_SECTIONS,
    template: UNITS_TEMPLATE,
  },
  {
    id: "unit-dependency",
    name: "unit-of-work-dependency.md",
    path: `${AIDLC_RECORD}/inception/units-generation/unit-of-work-dependency.md`,
    required: false,
    template: UNIT_DEPENDENCY_TEMPLATE,
  },
  {
    id: "bolt-plan",
    name: "bolt-plan.md",
    path: `${AIDLC_RECORD}/inception/units-generation/bolt-plan.md`,
    required: false,
    template: BOLT_PLAN_TEMPLATE,
  },
];

export const verifyPhase = {
  id: "verify",
  name: "Kiểm",
  kind: "verification" as const,
  optional: true,
  artifacts: [
    {
      id: "test-results",
      name: "test-results.md",
      path: `${AIDLC_RECORD}/construction/build-and-test/test-results.md`,
      required: false,
      template: TEST_RESULTS_TEMPLATE,
    },
  ],
  steps: [
    {
      id: "draft-test-results",
      action: "draft" as const,
      artifacts: ["test-results"],
      auto: false,
      prompt: TEST_RESULTS_PROMPT,
    },
  ],
};

export const operationPhase = {
  id: "operation",
  name: "Operation",
  kind: "release" as const,
  optional: true,
  artifacts: [
    {
      id: "runbook",
      name: "runbook.md",
      path: `${AIDLC_RECORD}/operation/runbook.md`,
      required: false,
      template: RUNBOOK_TEMPLATE,
    },
    {
      id: "release-notes",
      name: "release-notes.md",
      path: `${AIDLC_RECORD}/operation/release-notes.md`,
      required: false,
      template: RELEASE_NOTES_TEMPLATE,
    },
  ],
  steps: [
    {
      id: "release-notes",
      action: "release-notes" as const,
      artifacts: ["runbook", "release-notes"],
      auto: false,
      maxQuestions: 0,
      prompt: OPERATION_PROMPT,
    },
  ],
};

export const unitsDecomposition = {
  phase: "units",
  artifact: "units",
  parser: "aidlc-units" as const,
  granularity: "item" as const,
  requirementId: "REQ-\\d+",
  requirementSource: [{ phase: "requirements", artifact: "requirements" }],
  maxTasks: 30,
  maxChecklist: 20,
};

export const aidlcFeature = sdlcMode.parse({
  id: "aidlc-feature",
  name: "AI-DLC Feature",
  description:
    "Tính năng production, cỡ L: ý định và yêu cầu có PO duyệt, thiết kế và Unit có tech lead duyệt, mỗi Unit một task.",
  method: "aidlc",
  profile: "feature",
  sizes: ["L"],
  phases: [
    {
      id: "ideation",
      name: "Ý tưởng",
      kind: "intake",
      artifacts: [intentArtifact],
      steps: [{ id: "draft-intent", action: "draft", artifacts: ["intent"], maxQuestions: 3, prompt: INTENT_PROMPT }],
      gate: [
        {
          name: "Duyệt ý định",
          outputs: ["intent.md"],
          gates: [
            {
              id: "ai-intent",
              name: "AI kiểm ý định đủ ý",
              kind: "ai",
              ai: {
                checks: ["Người dùng và vấn đề rõ", "Thước đo thành công đo được", "Phạm vi có ranh giới"],
                passScore: 8,
              },
            },
            { id: "po", name: "PO duyệt ý định", kind: "human", reviewers: AIDLC_PO, slaHours: 24 },
          ],
        },
      ],
    },
    {
      id: "requirements",
      name: "Inception: yêu cầu",
      kind: "requirements",
      artifacts: [requirementsArtifact, storiesArtifact],
      steps: [
        {
          id: "draft-requirements",
          action: "draft",
          artifacts: ["requirements", "stories"],
          prompt: REQUIREMENTS_PROMPT,
        },
      ],
      gate: [
        {
          name: "Duyệt yêu cầu",
          outputs: ["requirements.md", "stories.md"],
          gates: [
            {
              id: "rules",
              name: "Đủ mục, mỗi yêu cầu có tiêu chí, hết câu hỏi mở",
              kind: "rule",
              rules: ["sections", "requirements", "no-open-questions"],
              sections: REQUIREMENT_SECTIONS,
            },
            {
              id: "ai-requirements",
              name: "AI kiểm yêu cầu đủ và kiểm được",
              kind: "ai",
              ai: { checks: AI_REQUIREMENTS_CHECKS, passScore: 8 },
            },
            { id: "po", name: "PO duyệt yêu cầu", kind: "human", reviewers: AIDLC_PO, slaHours: 24 },
          ],
        },
      ],
      perProjectGates: ["po"],
    },
    {
      id: "design",
      name: "Inception: thiết kế",
      kind: "design",
      artifacts: designArtifacts,
      steps: [
        {
          id: "draft-design",
          action: "draft",
          artifacts: ["components", "decisions", "contract"],
          maxQuestions: 3,
          prompt: DESIGN_PROMPT,
        },
      ],
      gate: [
        {
          name: "Duyệt thiết kế",
          outputs: ["components.md", "decisions.md"],
          gates: [
            {
              id: "rules",
              name: "Đủ mục của thiết kế",
              kind: "rule",
              rules: ["sections", "no-open-questions"],
              sections: DESIGN_SECTIONS,
            },
            {
              id: "ai-design",
              name: "AI đối chiếu yêu cầu",
              kind: "ai",
              ai: { checks: AI_DESIGN_CHECKS, passScore: 8 },
            },
            { id: "lead", name: "Tech lead duyệt thiết kế", kind: "human", reviewers: AIDLC_LEAD, slaHours: 24 },
          ],
        },
      ],
      perProjectGates: ["lead"],
    },
    {
      id: "units",
      name: "Inception: chia Unit",
      kind: "decomposition",
      artifacts: unitsArtifacts,
      steps: [
        {
          id: "draft-units",
          action: "draft",
          artifacts: ["units", "unit-dependency", "bolt-plan"],
          maxQuestions: 2,
          prompt: UNITS_PROMPT,
        },
      ],
      gate: [
        {
          name: "Duyệt Unit",
          outputs: ["unit-of-work.md"],
          gates: [
            {
              id: "rules",
              name: "Bản chia đọc được và phủ mọi yêu cầu",
              kind: "rule",
              rules: ["breakdown", "coverage"],
            },
            {
              id: "ai-units",
              name: "AI đọc chéo yêu cầu và Unit",
              kind: "ai",
              ai: { checks: AI_UNITS_CHECKS, passScore: 8 },
            },
            { id: "lead", name: "Tech lead duyệt Unit", kind: "human", reviewers: AIDLC_LEAD, slaHours: 24 },
          ],
        },
      ],
      perProjectGates: ["lead"],
      autoApprove: { gates: ["lead"], minScore: 9, revokeHours: 24 },
    },
    { id: "construction", name: "Construction", kind: "implementation" },
    verifyPhase,
    operationPhase,
  ],
  decomposition: unitsDecomposition,
  blocking: "hard",
  converge: { maxRounds: 0 },
  maxAgentRevisions: 2,
});
