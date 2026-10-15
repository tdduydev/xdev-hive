import { sdlcMode } from "../sdlc.ts";

/**
 * Preset `openspec`: thay đổi trên hệ thống đang chạy (brownfield), spec sống. Proposal → delta spec và design → tasks
 * → làm → archive (gộp delta vào `openspec/specs/`). Mỗi nhóm `## N.` của tasks.md là một task hub. Tài liệu nằm ở
 * `openspec/changes/{slug}/` để CLI OpenSpec trong repo đọc được. Khuôn và prompt do Hive viết.
 */

const CHANGE = "openspec/changes/{slug}";
const PO = { users: [], roles: ["team-ba", "team-admin"], quorum: 1 };
const LEAD = { users: [], roles: ["team-admin"], quorum: 1 };

const PROPOSAL_SECTIONS = ["Why", "What Changes", "Impact"];
const DELTA_SECTIONS = ["ADDED Requirements"];

const PROPOSAL_TEMPLATE = `# Change: …

## Why

Vấn đề hoặc cơ hội, một hai đoạn.

## What Changes

- Thay đổi chính. Thay đổi phá vỡ tương thích thì đánh dấu **BREAKING**.

## Impact

- Spec bị ảnh hưởng: …
- Code bị ảnh hưởng: …
`;

// Mỗi requirement mang mã REQ-nnn để tính độ phủ của tasks; tên requirement của OpenSpec vẫn đứng sau mã.
const DELTA_TEMPLATE = `# Delta spec

## ADDED Requirements

### Requirement: REQ-001 …

The system SHALL …

#### Scenario: …

- **WHEN** …
- **THEN** …

## MODIFIED Requirements

<!-- Chép nguyên requirement cũ rồi sửa; tên phải khớp spec hiện tại. -->

## REMOVED Requirements

<!-- Tên requirement bỏ đi, kèm lý do và cách chuyển đổi. -->
`;

const DESIGN_TEMPLATE = `# Design

## Context

Hệ thống hiện tại và ràng buộc.

## Decisions

- Quyết định, lựa chọn đã xét, lý do.

## Risks / Trade-offs

- Rủi ro, cách giảm.

## Migration Plan

Các bước chuyển và cách quay lui.
`;

const TASKS_TEMPLATE = `# Tasks

## 1. Nhóm việc đầu tiên

- [ ] 1.1 Việc cụ thể, nêu file (REQ-001)
- [ ] 1.2 Test cho việc trên

## 2. Nhóm việc tiếp theo

**Phụ thuộc**: 1

- [ ] 2.1 …
`;

const CONTEXT = `Bối cảnh đã có (tài liệu, câu trả lời, góp ý của người duyệt):
{artifacts}
{answers}
{feedback}`;

const RULES = `Điều chặn việc mà repo không trả lời được thì gọi \`sdlc_ask\` (kèm đề xuất). Chưa có trả lời thì để
\`[NEEDS CLARIFICATION: câu hỏi]\` đúng chỗ đó, không tự quyết. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

const PROPOSAL_PROMPT = `Bạn viết proposal.md cho một thay đổi theo OpenSpec.

Ý tưởng của người giao:
{idea}

${CONTEXT}

Cách làm:
1. Đọc \`openspec/specs/\` và code liên quan trước: proposal mô tả thay đổi so với cái đang có.
2. Nêu lý do, thay đổi chính (đánh dấu BREAKING nếu có) và spec, code bị ảnh hưởng.
3. ${RULES}`;

const DESIGN_PROMPT = `Bạn viết delta spec và design cho thay đổi OpenSpec đã duyệt proposal.

Các dự án tham gia:
{projects}

${CONTEXT}

Cách làm:
1. Delta spec chỉ ghi phần đổi: ADDED, MODIFIED (chép nguyên rồi sửa), REMOVED. Mỗi requirement mới là
   \`### Requirement: REQ-nnn Tên\`, dùng SHALL, có ít nhất một \`#### Scenario:\` với WHEN/THEN.
2. design.md chỉ cần khi thay đổi chạm nhiều module, có migration hoặc quyết định khó đảo ngược.
3. Giao tiếp giữa hai repo viết thành contract riêng (\`contracts/<tên>.<đuôi>\`).
4. ${RULES}`;

const TASKS_PROMPT = `Bạn viết tasks.md cho thay đổi OpenSpec. Mỗi nhóm \`## N. Tên\` là một task của hub: một run, một PR.

Các dự án tham gia:
{projects}

${CONTEXT}

Cách làm:
1. Trong nhóm là checklist \`- [ ] N.M Việc\`, mỗi việc nêu file cụ thể và nhắc REQ-nnn nó phủ.
2. Nhóm làm ở repo khác dự án chính thì thêm dòng \`Dự án: <khoá>\` ngay dưới tiêu đề nhóm.
3. Ghi \`**Phụ thuộc**: 1\` khi nhóm cần nhóm khác xong trước. Không tạo phụ thuộc vòng. Mọi REQ-nnn phải có việc.
4. ${RULES}`;

const ARCHIVE_PROMPT = `Bạn archive thay đổi OpenSpec đã làm xong: gộp delta spec vào spec sống.

${CONTEXT}

Cách làm:
1. Đọc delta spec đã duyệt và spec hiện tại trong \`openspec/specs/\`.
2. Viết lại spec sống: thêm requirement ADDED, thay requirement MODIFIED, bỏ requirement REMOVED. Giữ nguyên phần khác.
3. Chỉ ghi file tài liệu. Không sửa code, không commit, không xoá thư mục change (hub làm khi cổng đạt).`;

export const openspec = sdlcMode.parse({
  id: "openspec",
  name: "OpenSpec",
  description:
    "Brownfield, spec sống, cỡ M–L: proposal có PO duyệt, delta spec và design có tech lead duyệt, mỗi nhóm việc một task, archive vào spec sống.",
  method: "openspec",
  profile: "change",
  sizes: ["M", "L"],
  phases: [
    {
      id: "proposal",
      name: "Proposal",
      kind: "requirements",
      artifacts: [
        {
          id: "proposal",
          name: "proposal.md",
          path: `${CHANGE}/proposal.md`,
          sections: PROPOSAL_SECTIONS,
          template: PROPOSAL_TEMPLATE,
        },
      ],
      steps: [
        {
          id: "draft-proposal",
          action: "draft",
          artifacts: ["proposal"],
          skill: "openspec-proposal",
          prompt: PROPOSAL_PROMPT,
        },
      ],
      gate: [
        {
          name: "Duyệt proposal",
          outputs: ["proposal.md"],
          gates: [
            {
              id: "rules",
              name: "Đủ mục, hết câu hỏi mở",
              kind: "rule",
              rules: ["sections", "no-open-questions"],
              sections: PROPOSAL_SECTIONS,
            },
            { id: "po", name: "PO duyệt proposal", kind: "human", reviewers: PO, slaHours: 24 },
          ],
        },
      ],
      perProjectGates: ["po"],
    },
    {
      id: "design",
      name: "Delta spec và design",
      kind: "design",
      artifacts: [
        // Một delta spec cho capability cùng tên với thay đổi; capability khác thì agent ghi thêm file cạnh đó.
        {
          id: "delta-spec",
          name: "spec.md (delta)",
          path: `${CHANGE}/specs/{slug}/spec.md`,
          sections: DELTA_SECTIONS,
          template: DELTA_TEMPLATE,
        },
        { id: "design", name: "design.md", path: `${CHANGE}/design.md`, required: false, template: DESIGN_TEMPLATE },
        // Hai đội phải đồng ý trước khi cùng cài đặt (D23).
        {
          id: "contract",
          name: "Contract liên repo",
          path: `${CHANGE}/contracts/{name}.{ext}`,
          required: false,
          scope: "contract",
          repeatable: true,
        },
      ],
      steps: [
        {
          id: "draft-design",
          action: "draft",
          artifacts: ["delta-spec", "design", "contract"],
          maxQuestions: 3,
          prompt: DESIGN_PROMPT,
        },
      ],
      gate: [
        {
          name: "Duyệt delta spec và design",
          outputs: ["spec.md", "design.md"],
          gates: [
            {
              id: "rules",
              name: "Có requirement mới, hết câu hỏi mở",
              kind: "rule",
              rules: ["sections", "no-open-questions"],
              sections: DELTA_SECTIONS,
            },
            {
              id: "ai-design",
              name: "AI đối chiếu proposal và spec hiện tại",
              kind: "ai",
              ai: {
                checks: [
                  "Delta khớp proposal, không mâu thuẫn spec sống",
                  "Mỗi requirement có mã REQ-nnn, dùng SHALL và có scenario",
                  "Giao tiếp giữa các repo đã thành contract",
                ],
                passScore: 8,
              },
            },
            { id: "lead", name: "Tech lead duyệt", kind: "human", reviewers: LEAD, slaHours: 24 },
          ],
        },
      ],
      perProjectGates: ["lead"],
    },
    {
      id: "tasks",
      name: "Tasks",
      kind: "decomposition",
      artifacts: [{ id: "tasks", name: "tasks.md", path: `${CHANGE}/tasks.md`, template: TASKS_TEMPLATE }],
      steps: [{ id: "draft-tasks", action: "draft", artifacts: ["tasks"], maxQuestions: 2, prompt: TASKS_PROMPT }],
      gate: [
        {
          name: "Duyệt tasks",
          outputs: ["tasks.md"],
          gates: [
            {
              id: "rules",
              name: "Bản tách đọc được và phủ mọi yêu cầu",
              kind: "rule",
              rules: ["breakdown", "coverage"],
            },
            {
              id: "ai-tasks",
              name: "AI đọc chéo delta spec và tasks",
              kind: "ai",
              ai: {
                checks: [
                  "Mỗi việc nêu file cụ thể và REQ-nnn nó phủ",
                  "Thứ tự và phụ thuộc giữa các nhóm hợp lý, có test",
                  "Mỗi nhóm giao được cho một run và một PR",
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
    },
    { id: "implement", name: "Implement", kind: "implementation" },
    {
      id: "archive",
      name: "Archive",
      kind: "release",
      optional: true,
      artifacts: [
        {
          id: "living-spec",
          name: "spec.md (spec sống)",
          path: "openspec/specs/{slug}/spec.md",
          required: false,
        },
      ],
      steps: [
        {
          id: "archive",
          action: "archive",
          artifacts: ["delta-spec", "living-spec"],
          auto: false,
          maxQuestions: 0,
          skill: "openspec-archive",
          prompt: ARCHIVE_PROMPT,
        },
      ],
      gate: [
        {
          name: "Duyệt spec sống",
          outputs: ["spec.md"],
          gates: [{ id: "lead", name: "Tech lead duyệt bản gộp", kind: "human", reviewers: LEAD, slaHours: 24 }],
        },
      ],
    },
  ],
  decomposition: {
    phase: "tasks",
    artifact: "tasks",
    parser: "openspec-tasks",
    granularity: "heading",
    requirementId: "REQ-\\d{3}",
    requirementSource: [{ phase: "design", artifact: "delta-spec" }],
    maxTasks: 30,
    maxChecklist: 20,
  },
  blocking: "hard",
  converge: { maxRounds: 0 },
  maxAgentRevisions: 2,
});
