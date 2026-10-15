import { sdlcMode } from "../sdlc.ts";

/**
 * Preset `bmad-method`: BMAD Method đầy đủ cho sản phẩm nhiều epic, cỡ L–XL. Analysis (brief, tuỳ chọn) → Planning (PRD)
 * → Solutioning (architecture, rồi epics/stories kèm kiểm readiness) → Implementation → Retro. Mỗi Story là một task hub.
 * Khuôn và prompt do Hive viết; đường dẫn theo thư mục `_bmad-output` của BMAD để agent BMAD trong repo đọc được.
 */

const PLANNING = "_bmad-output/planning-artifacts/{slug}";
const LEAD = { users: [], roles: ["team-admin"], quorum: 1 };

const BRIEF_SECTIONS = ["Vấn đề", "Người dùng", "Giải pháp đề xuất", "Thước đo thành công"];
const PRD_SECTIONS = ["Mục tiêu", "Người dùng", "Yêu cầu chức năng", "Yêu cầu phi chức năng", "Ngoài phạm vi"];
const ARCHITECTURE_SECTIONS = ["Bối cảnh", "Thành phần", "Dữ liệu", "Quyết định", "Rủi ro"];
const EPICS_SECTIONS = ["Epics"];

const BRIEF_TEMPLATE = `# Product brief

## Vấn đề

Ai gặp vấn đề gì, đang tốn bao nhiêu.

## Người dùng

- Nhóm người dùng chính và việc họ cần làm.

## Giải pháp đề xuất

Một đoạn, chưa đi vào kỹ thuật.

## Thước đo thành công

- Số đo được sau khi phát hành.
`;

const PRD_TEMPLATE = `# PRD

## Mục tiêu

- Mục tiêu kinh doanh và người dùng.

## Người dùng

- Persona, hành trình chính.

## Yêu cầu chức năng

- **FR1**: Người dùng có thể …
- **FR2**: Hệ thống …

## Yêu cầu phi chức năng

- **NFR1**: Hiệu năng, bảo mật, khả năng truy cập… (số đo).

## Ngoài phạm vi

- …
`;

const ARCHITECTURE_TEMPLATE = `# Architecture

## Bối cảnh

Hệ thống hiện tại, ràng buộc kỹ thuật, các repo tham gia.

## Thành phần

| Thành phần | Trách nhiệm | Repo, thư mục |
|---|---|---|
| … | … | … |

## Dữ liệu

Bảng, sự kiện, luồng dữ liệu cho từng FR chính.

## Quyết định

- Quyết định, lựa chọn đã xét, lý do.

## Rủi ro

- Rủi ro, cách giảm.
`;

const EPICS_TEMPLATE = `# Epics

## Epic 1: …

Mục tiêu: … (FR1).

### Story 1.1: …

As a …,
I want …,
so that ….

#### Acceptance Criteria

1. Given … when … then … (FR1)

#### Tasks / Subtasks

- [ ] Việc cụ thể, nêu file
- [ ] Test cho tiêu chí trên

### Story 1.2: …

**Phụ thuộc**: Story 1.1

- [ ] …
`;

const RETRO_TEMPLATE = `# Retrospective

## Điều làm tốt

- …

## Điều cần đổi

- …

## Việc mang sang lần sau

- [ ] …
`;

const CONTEXT = `Bối cảnh đã có (tài liệu, câu trả lời, góp ý của người duyệt):
{artifacts}
{answers}
{feedback}`;

const RULES = `Điều chặn việc mà repo không trả lời được thì gọi \`sdlc_ask\` (kèm đề xuất). Chưa có trả lời thì để
\`[NEEDS CLARIFICATION: câu hỏi]\` đúng chỗ đó, không tự quyết. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

const BRIEF_PROMPT = `Bạn là Analyst của BMAD. Viết product brief cho ý tưởng dưới đây.

Ý tưởng của người giao:
{idea}

${CONTEXT}

Cách làm:
1. Đọc repo để biết sản phẩm đang có gì.
2. Nêu vấn đề, người dùng và thước đo; giải pháp chỉ một đoạn, chưa đi vào kỹ thuật.
3. ${RULES}`;

const PRD_PROMPT = `Bạn là PM của BMAD. Viết PRD từ brief (nếu có) và ý tưởng.

Ý tưởng của người giao:
{idea}

${CONTEXT}

Cách làm:
1. Mỗi yêu cầu chức năng có mã FRn, phi chức năng có mã NFRn, viết sao cho kiểm được.
2. Ghi rõ ngoài phạm vi để Architect và SM không tự mở rộng.
3. ${RULES}`;

const ARCHITECTURE_PROMPT = `Bạn là Architect của BMAD. Viết architecture từ PRD đã duyệt.

Các dự án tham gia:
{projects}

${CONTEXT}

Cách làm:
1. Đọc code thật của từng repo tham gia; tái dùng cái có sẵn.
2. Mọi FRn, NFRn có thành phần nhận. Quyết định có lựa chọn đã xét và lý do.
3. Giao tiếp giữa hai repo viết thành contract riêng (\`contracts/<tên>.<đuôi>\`).
4. ${RULES}`;

const EPICS_PROMPT = `Bạn là PM và SM của BMAD. Chia PRD và architecture đã duyệt thành epic và story. Mỗi story là một task của hub:
một run, một PR.

Các dự án tham gia:
{projects}

${CONTEXT}

Cách làm:
1. Epic là \`## Epic N: Tên\`, story là \`### Story N.M: Tên\` kèm user story và Acceptance Criteria nhắc FRn.
2. Story làm ở repo khác dự án chính thì thêm dòng \`Dự án: <khoá>\` ngay dưới tiêu đề story.
3. Ghi \`**Phụ thuộc**: Story N.M\` khi story cần story khác xong trước. Không tạo phụ thuộc vòng.
4. Mỗi story có \`#### Tasks / Subtasks\` là checklist \`- [ ] …\` nêu file cụ thể. Mọi FRn phải có story.
5. ${RULES}`;

const READINESS_PROMPT = `Bạn kiểm readiness của BMAD (implementation readiness) trước khi code: đọc PRD, architecture, epics.

${CONTEXT}

Ghi nhận xét vào kết quả, không sửa tài liệu:
1. FRn, NFRn nào chưa có story; story nào không truy về FRn.
2. Story nào mâu thuẫn architecture hoặc quá lớn cho một PR.
3. Kết luận PASS, CONCERNS hoặc FAIL kèm lý do; hub đổi thành điểm của checkpoint AI.`;

const RETRO_PROMPT = `Bạn chủ trì retrospective của BMAD sau khi các story đã merge.

${CONTEXT}

Cách làm:
1. Đọc các PR đã merge, các lượt trả lại của người duyệt và kết quả CI.
2. Ghi điều làm tốt, điều cần đổi và việc mang sang lần sau; mỗi ý có bằng chứng (PR, review).
3. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

export const bmadMethod = sdlcMode.parse({
  id: "bmad-method",
  name: "BMAD Method",
  description:
    "Sản phẩm nhiều epic, cỡ L–XL: PRD có PO duyệt, architecture và epics có AI kiểm readiness và tech lead duyệt, mỗi story một task.",
  method: "bmad",
  profile: "method",
  sizes: ["L", "XL"],
  phases: [
    {
      id: "analysis",
      name: "Analysis",
      kind: "intake",
      optional: true,
      artifacts: [
        {
          id: "brief",
          name: "product-brief.md",
          path: `${PLANNING}/product-brief.md`,
          required: false,
          sections: BRIEF_SECTIONS,
          template: BRIEF_TEMPLATE,
        },
      ],
      steps: [{ id: "draft-brief", action: "draft", artifacts: ["brief"], maxQuestions: 3, prompt: BRIEF_PROMPT }],
    },
    {
      id: "planning",
      name: "Planning",
      kind: "requirements",
      artifacts: [
        { id: "prd", name: "prd.md", path: `${PLANNING}/prd.md`, sections: PRD_SECTIONS, template: PRD_TEMPLATE },
      ],
      steps: [{ id: "draft-prd", action: "draft", artifacts: ["prd"], skill: "bmad-create-prd", prompt: PRD_PROMPT }],
      gate: [
        {
          name: "Duyệt PRD",
          outputs: ["prd.md"],
          gates: [
            {
              id: "rules",
              name: "Đủ mục của PRD, hết câu hỏi mở",
              kind: "rule",
              rules: ["sections", "no-open-questions"],
              sections: PRD_SECTIONS,
            },
            {
              id: "po",
              name: "PO duyệt PRD",
              kind: "human",
              reviewers: { users: [], roles: ["team-ba", "team-admin"], quorum: 1 },
              slaHours: 24,
            },
          ],
        },
      ],
      perProjectGates: ["po"],
    },
    {
      id: "solutioning",
      name: "Solutioning",
      kind: "design",
      artifacts: [
        {
          id: "architecture",
          name: "architecture.md",
          path: `${PLANNING}/architecture.md`,
          sections: ARCHITECTURE_SECTIONS,
          template: ARCHITECTURE_TEMPLATE,
        },
        // Hai đội phải đồng ý trước khi cùng cài đặt (D23).
        {
          id: "contract",
          name: "Contract liên repo",
          path: `${PLANNING}/contracts/{name}.{ext}`,
          required: false,
          scope: "contract",
          repeatable: true,
        },
      ],
      steps: [
        {
          id: "draft-architecture",
          action: "draft",
          artifacts: ["architecture", "contract"],
          skill: "bmad-create-architecture",
          maxQuestions: 3,
          prompt: ARCHITECTURE_PROMPT,
        },
      ],
      gate: [
        {
          name: "Duyệt architecture",
          outputs: ["architecture.md"],
          gates: [
            {
              id: "rules",
              name: "Đủ mục của architecture",
              kind: "rule",
              rules: ["sections", "no-open-questions"],
              sections: ARCHITECTURE_SECTIONS,
            },
            {
              id: "ai-architecture",
              name: "AI đối chiếu PRD",
              kind: "ai",
              ai: {
                checks: [
                  "Mọi FRn, NFRn có thành phần nhận",
                  "Quyết định có lựa chọn đã xét và lý do",
                  "Giao tiếp giữa các repo đã thành contract",
                ],
                passScore: 8,
              },
            },
            { id: "lead", name: "Tech lead duyệt architecture", kind: "human", reviewers: LEAD, slaHours: 24 },
          ],
        },
      ],
      perProjectGates: ["lead"],
    },
    {
      id: "epics",
      name: "Epics và stories",
      kind: "decomposition",
      artifacts: [
        {
          id: "epics",
          name: "epics.md",
          path: `${PLANNING}/epics.md`,
          sections: EPICS_SECTIONS,
          template: EPICS_TEMPLATE,
        },
      ],
      steps: [
        {
          id: "draft-epics",
          action: "draft",
          artifacts: ["epics"],
          skill: "bmad-create-epics-and-stories",
          maxQuestions: 2,
          prompt: EPICS_PROMPT,
        },
        // Đọc chéo bằng CLI khác với CLI soạn để không tự chấm bài mình; kết quả vào checkpoint AI của cổng.
        {
          id: "readiness",
          action: "analyze",
          artifacts: ["prd", "architecture", "epics"],
          cli: "codex",
          maxQuestions: 0,
          skill: "bmad-check-implementation-readiness",
          prompt: READINESS_PROMPT,
        },
      ],
      gate: [
        {
          name: "Duyệt epics và stories",
          outputs: ["epics.md"],
          gates: [
            {
              id: "rules",
              name: "Bản tách đọc được và phủ mọi yêu cầu",
              kind: "rule",
              rules: ["breakdown", "coverage"],
            },
            {
              id: "ai-readiness",
              name: "AI kiểm readiness",
              kind: "ai",
              ai: {
                checks: [
                  "Mọi FRn, NFRn có story và mỗi story truy về FRn",
                  "Story khớp architecture và vừa một PR",
                  "Thứ tự và phụ thuộc giữa các story hợp lý",
                ],
                passScore: 8,
              },
            },
            { id: "lead", name: "Tech lead duyệt stories", kind: "human", reviewers: LEAD, slaHours: 24 },
          ],
        },
      ],
      perProjectGates: ["lead"],
      autoApprove: { gates: ["lead"], minScore: 9, revokeHours: 24 },
    },
    { id: "implementation", name: "Implementation", kind: "implementation" },
    {
      id: "retro",
      name: "Retro",
      kind: "release",
      optional: true,
      artifacts: [
        {
          id: "retro",
          name: "retrospective.md",
          path: "_bmad-output/implementation-artifacts/{slug}/retrospective.md",
          required: false,
          template: RETRO_TEMPLATE,
        },
      ],
      steps: [
        { id: "retro", action: "retro", artifacts: ["retro"], auto: false, maxQuestions: 0, prompt: RETRO_PROMPT },
      ],
    },
  ],
  decomposition: {
    phase: "epics",
    artifact: "epics",
    parser: "bmad-stories",
    granularity: "item",
    requirementId: "N?FR\\d+",
    requirementSource: [{ phase: "planning", artifact: "prd" }],
    maxTasks: 30,
    maxChecklist: 20,
  },
  blocking: "hard",
  converge: { maxRounds: 0 },
  maxAgentRevisions: 2,
});
