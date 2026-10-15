import { type SdlcModeInput, sdlcMode } from "../sdlc.ts";
import type { ReviewGateInput } from "../workflows.ts";

/**
 * Preset theo spec của Kiro: `kiro-requirements` (Requirements → Design → Tasks), `kiro-design` (đã có kiến trúc nên
 * Design trước) và `kiro-bugfix` (Bugfix → Tasks). Tài liệu nằm ở `.kiro/specs/{slug}/` để Kiro trong repo đọc được.
 * Tiêu chí chấp nhận viết theo EARS ("WHEN … THE SYSTEM SHALL …"), mã `N.M` là tiêu chí M của Requirement N; tasks.md
 * nhắc lại mã đó trong `_Requirements: 1.1_`. Khuôn và prompt do Hive viết.
 */

type Phase = SdlcModeInput["phases"][number];
type Reviewers = ReviewGateInput["reviewers"];

const DIR = ".kiro/specs/{slug}";
// `N.M` không đứng trong số dài hơn (phiên bản `1.2.3`): mã tiêu chí của Requirement N.
const REQUIREMENT_ID = "(?<![\\d.])\\d+\\.\\d+(?![\\d.]*\\d)";
const PO: Reviewers = { users: [], roles: ["team-ba", "team-admin"], quorum: 1 };
const LEAD: Reviewers = { users: [], roles: ["team-admin"], quorum: 1 };

const REQUIREMENTS_SECTIONS = ["Introduction", "Requirements"];
const DESIGN_SECTIONS = [
  "Overview",
  "Architecture",
  "Components and Interfaces",
  "Data Models",
  "Error Handling",
  "Testing Strategy",
];
const BUGFIX_SECTIONS = ["Current Behavior", "Expected Behavior", "Unchanged Behavior", "Root Cause"];

const REQUIREMENTS_TEMPLATE = `# Requirements Document

## Introduction

Tính năng làm gì, cho ai, vì sao.

## Requirements

### Requirement 1

**User Story:** As a …, I want …, so that …

#### Acceptance Criteria

1. **1.1** WHEN … THEN THE SYSTEM SHALL …
2. **1.2** IF … THEN THE SYSTEM SHALL …
`;

const DESIGN_TEMPLATE = `# Design Document

## Overview

Cách tiếp cận trong một đoạn.

## Architecture

Thành phần chính và cách chúng nối với nhau; repo nào đổi gì.

## Components and Interfaces

- Thành phần, API, sự kiện. Giao tiếp giữa hai repo viết thành contract riêng.

## Data Models

Bảng, kiểu dữ liệu mới hoặc đổi.

## Error Handling

Lỗi có thể xảy ra và cách xử lý.

## Testing Strategy

Test nào phủ tiêu chí nào.
`;

const TASKS_TEMPLATE = `# Implementation Plan

- [ ] 1. Việc đầu tiên, nêu file cụ thể
  - Chi tiết cách làm
  - _Requirements: 1.1_

- [ ] 2. Việc tiếp theo
  - _Depends on: 1_
  - _Requirements: 1.2_
  - [ ] 2.1 Việc con
  - [ ] 2.2 Test cho việc con
`;

const BUGFIX_TEMPLATE = `# Bugfix

## Current Behavior

1. **1.1** WHEN … THEN THE SYSTEM … (hiện tượng sai, cách tái hiện)

## Expected Behavior

1. **2.1** WHEN … THEN THE SYSTEM SHALL …

## Unchanged Behavior

1. **3.1** WHEN … THEN THE SYSTEM SHALL CONTINUE TO …

## Root Cause

Nguyên nhân đã xác minh trong code (file, dòng), không đoán.
`;

const CONTEXT = `Bối cảnh đã có (tài liệu, câu trả lời, góp ý của người duyệt):
{artifacts}
{answers}
{feedback}`;

const RULES = `Điều chặn việc mà repo không trả lời được thì gọi \`sdlc_ask\` (kèm đề xuất). Chưa có trả lời thì để
\`[NEEDS CLARIFICATION: câu hỏi]\` đúng chỗ đó, không tự quyết. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

const REQUIREMENTS_PROMPT = `Bạn viết requirements.md theo spec của Kiro.

Ý tưởng của người giao:
{idea}

${CONTEXT}

Cách làm:
1. Đọc repo (và design.md nếu đã có) để yêu cầu khớp hệ thống thật.
2. Mỗi \`### Requirement N\` có User Story và \`#### Acceptance Criteria\` đánh số.
3. Mỗi tiêu chí mở đầu bằng mã \`**N.M**\` rồi viết theo EARS: \`WHEN <sự kiện> THEN THE SYSTEM SHALL <phản hồi>\`
   (hoặc IF/WHILE/WHERE). Từ khoá EARS viết hoa.
4. ${RULES}`;

const DESIGN_PROMPT = `Bạn viết design.md theo spec của Kiro.

Các dự án tham gia:
{projects}

${CONTEXT}

Cách làm:
1. Đọc code thật của từng repo tham gia; tái dùng cái có sẵn.
2. Đủ các mục của khuôn. Nếu đã có requirements.md, mỗi tiêu chí N.M phải có chỗ trong thiết kế.
3. Giao tiếp giữa hai repo viết thành contract riêng (\`contracts/<tên>.<đuôi>\`) khi chế độ có contract.
4. ${RULES}`;

const TASKS_PROMPT = `Bạn viết tasks.md theo spec của Kiro. Mỗi task đánh số là một task của hub: một run, một PR.

Các dự án tham gia:
{projects}

${CONTEXT}

Cách làm:
1. Task là \`- [ ] N. Tên\`; việc con là \`- [ ] N.M Tên\` thụt dưới task, thành checklist của task.
2. Task làm ở repo khác dự án chính thì thêm thẻ \`[@<khoá>]\` ngay sau số: \`- [ ] 3. [@<khoá>] Tên\`.
3. Mỗi task có \`_Requirements: 1.1, 1.2_\` nhắc tiêu chí nó phủ; mọi tiêu chí phải có task.
4. Ghi \`_Depends on: 1, 2_\` khi task cần task khác xong trước. Không tạo phụ thuộc vòng. Test đứng cùng hoặc trước code.
5. ${RULES}`;

const BUGFIX_PROMPT = `Bạn viết bugfix.md theo spec sửa lỗi của Kiro.

Mô tả lỗi của người giao:
{idea}

${CONTEXT}

Cách làm:
1. Tái hiện lỗi bằng cách đọc code và test hiện có; ghi nguyên nhân đã xác minh (file, dòng).
2. Mỗi mục đánh mã \`**N.M**\` và viết theo EARS: hành vi sai hiện tại (1.x), hành vi đúng (2.x), hành vi phải giữ
   nguyên (3.x, dùng \`SHALL CONTINUE TO\`).
3. ${RULES}`;

const requirementsPhase: Phase = {
  id: "requirements",
  name: "Requirements",
  kind: "requirements",
  artifacts: [
    {
      id: "requirements",
      name: "requirements.md",
      path: `${DIR}/requirements.md`,
      sections: REQUIREMENTS_SECTIONS,
      template: REQUIREMENTS_TEMPLATE,
    },
  ],
  steps: [{ id: "draft-requirements", action: "draft", artifacts: ["requirements"], prompt: REQUIREMENTS_PROMPT }],
  gate: [
    {
      name: "Duyệt requirements",
      outputs: ["requirements.md"],
      gates: [
        {
          id: "rules",
          name: "Đủ mục, tiêu chí theo EARS, hết câu hỏi mở",
          kind: "rule",
          rules: ["sections", "ears", "no-open-questions"],
          sections: REQUIREMENTS_SECTIONS,
        },
        { id: "po", name: "PO duyệt requirements", kind: "human", reviewers: PO, slaHours: 24 },
      ],
    },
  ],
  perProjectGates: ["po"],
};

const designPhase = (contract: boolean): Phase => ({
  id: "design",
  name: "Design",
  kind: "design",
  artifacts: [
    { id: "design", name: "design.md", path: `${DIR}/design.md`, sections: DESIGN_SECTIONS, template: DESIGN_TEMPLATE },
    // Hai đội phải đồng ý trước khi cùng cài đặt (D23).
    ...(contract
      ? [
          {
            id: "contract",
            name: "Contract liên repo",
            path: `${DIR}/contracts/{name}.{ext}`,
            required: false,
            scope: "contract" as const,
            repeatable: true,
          },
        ]
      : []),
  ],
  steps: [
    {
      id: "draft-design",
      action: "draft",
      artifacts: contract ? ["design", "contract"] : ["design"],
      maxQuestions: 3,
      prompt: DESIGN_PROMPT,
    },
  ],
  gate: [
    {
      name: "Duyệt design",
      outputs: ["design.md"],
      gates: [
        {
          id: "rules",
          name: "Đủ mục của design",
          kind: "rule",
          rules: ["sections", "no-open-questions"],
          sections: DESIGN_SECTIONS,
        },
        {
          id: "ai-design",
          name: "AI đối chiếu requirements",
          kind: "ai",
          ai: {
            checks: [
              "Mỗi tiêu chí chấp nhận có chỗ trong thiết kế",
              "Thiết kế tái dùng code có sẵn",
              "Có cách xử lý lỗi và chiến lược test",
            ],
            passScore: 8,
          },
        },
        { id: "lead", name: "Tech lead duyệt design", kind: "human", reviewers: LEAD, slaHours: 24 },
      ],
    },
  ],
  perProjectGates: ["lead"],
});

const tasksPhase: Phase = {
  id: "tasks",
  name: "Tasks",
  kind: "decomposition",
  artifacts: [{ id: "tasks", name: "tasks.md", path: `${DIR}/tasks.md`, template: TASKS_TEMPLATE }],
  steps: [{ id: "draft-tasks", action: "draft", artifacts: ["tasks"], maxQuestions: 2, prompt: TASKS_PROMPT }],
  gate: [
    {
      name: "Duyệt tasks",
      outputs: ["tasks.md"],
      gates: [
        { id: "rules", name: "Bản tách đọc được và phủ mọi tiêu chí", kind: "rule", rules: ["breakdown", "coverage"] },
        {
          id: "ai-tasks",
          name: "AI đọc chéo requirements, design, tasks",
          kind: "ai",
          ai: {
            checks: [
              "Mỗi task nhắc tiêu chí nó phủ và nêu file cụ thể",
              "Thứ tự và phụ thuộc hợp lý, có test",
              "Mỗi task giao được cho một run và một PR",
            ],
            passScore: 8,
          },
        },
        { id: "lead", name: "Tech lead duyệt tasks", kind: "human", reviewers: LEAD, slaHours: 24 },
      ],
    },
  ],
  perProjectGates: ["lead"],
  autoApprove: { gates: ["lead"], minScore: 9, revokeHours: 24 },
};

const implementPhase: Phase = { id: "implement", name: "Implement", kind: "implementation" };

const decomposition = (source: string) => ({
  phase: "tasks",
  artifact: "tasks",
  parser: "kiro-tasks" as const,
  granularity: "item" as const,
  requirementId: REQUIREMENT_ID,
  requirementSource: [{ phase: source, artifact: source }],
  maxTasks: 30,
  maxChecklist: 20,
});

export const kiroRequirements = sdlcMode.parse({
  id: "kiro-requirements",
  name: "Kiro: Requirements trước",
  description:
    "Cỡ M–L: requirements theo EARS có PO duyệt, design và tasks có tech lead duyệt, mỗi task đánh số một task.",
  method: "kiro",
  profile: "requirements-first",
  sizes: ["M", "L"],
  phases: [requirementsPhase, designPhase(true), tasksPhase, implementPhase],
  decomposition: decomposition("requirements"),
  blocking: "hard",
  converge: { maxRounds: 0 },
  maxAgentRevisions: 2,
});

export const kiroDesign = sdlcMode.parse({
  id: "kiro-design",
  name: "Kiro: Design trước",
  description: "Đã có kiến trúc: design trước, requirements theo EARS sau, rồi tasks.",
  method: "kiro",
  profile: "design-first",
  sizes: ["M", "L"],
  phases: [designPhase(false), requirementsPhase, tasksPhase, implementPhase],
  decomposition: decomposition("requirements"),
  blocking: "hard",
  converge: { maxRounds: 0 },
  maxAgentRevisions: 2,
});

export const kiroBugfix = sdlcMode.parse({
  id: "kiro-bugfix",
  name: "Kiro: Bugfix",
  description: "Lỗi theo Kiro: bugfix.md theo EARS có tech lead duyệt, rồi tasks, chặn mềm.",
  method: "kiro",
  profile: "bugfix",
  sizes: ["S", "M"],
  phases: [
    {
      id: "bugfix",
      name: "Bugfix",
      kind: "requirements",
      artifacts: [
        {
          id: "bugfix",
          name: "bugfix.md",
          path: `${DIR}/bugfix.md`,
          sections: BUGFIX_SECTIONS,
          template: BUGFIX_TEMPLATE,
        },
      ],
      steps: [{ id: "draft-bugfix", action: "draft", artifacts: ["bugfix"], maxQuestions: 3, prompt: BUGFIX_PROMPT }],
      gate: [
        {
          name: "Duyệt bugfix",
          outputs: ["bugfix.md"],
          gates: [
            {
              id: "rules",
              name: "Đủ mục, hết câu hỏi mở",
              kind: "rule",
              rules: ["sections", "no-open-questions"],
              sections: BUGFIX_SECTIONS,
            },
            { id: "lead", name: "Tech lead duyệt bugfix", kind: "human", reviewers: LEAD, slaHours: 8 },
          ],
        },
      ],
      perProjectGates: ["lead"],
    },
    tasksPhase,
    implementPhase,
  ],
  decomposition: decomposition("bugfix"),
  blocking: "soft",
  converge: { maxRounds: 0 },
  maxAgentRevisions: 2,
});
