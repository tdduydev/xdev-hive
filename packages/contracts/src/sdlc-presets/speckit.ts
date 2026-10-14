import { sdlcMode } from "../sdlc.ts";

/**
 * Preset `speckit`: mặc định của repo này, cỡ M–L. Tham khảo luồng của GitHub Spec Kit (specify → clarify → plan → tasks →
 * implement) và cách chia tài liệu `specs/NNN-slug/{spec,plan,tasks}.md`. Clarify nằm trong bước soạn Specify (agent hỏi
 * qua `sdlc_ask`, ghi quyết định vào mục Clarifications) thay vì một giai đoạn riêng. Tiêu đề mục giữ tiếng Anh theo Spec
 * Kit để skill `speckit-*` có trong repo đọc được; khuôn và prompt do Hive tự viết, không chép nguyên văn.
 */

const SPEC_SECTIONS = ["User Scenarios & Testing", "Requirements", "Success Criteria"];
const PLAN_SECTIONS = ["Summary", "Technical Context", "Constitution Check", "Project Structure"];

const SPEC_TEMPLATE = `# Spec: tên hạng mục

## Clarifications

Quyết định đã chốt qua hỏi–đáp, mỗi dòng một quyết định (câu hỏi → trả lời, ai chốt, ngày).

## User Scenarios & Testing

### User Story 1 - Tên ngắn (Priority: P1)

Ai làm gì, để đạt điều gì. Vì sao thứ tự ưu tiên này.

**Independent Test**: Cách kiểm riêng câu chuyện này, đủ để thấy giá trị.

**Acceptance Scenarios**:

1. **Given** trạng thái đầu, **When** hành động, **Then** kết quả kiểm được.

### Edge Cases

- Điều gì xảy ra khi …

## Requirements

### Functional Requirements

- **FR-001**: Hệ thống MUST …
  - Tiêu chí chấp nhận: Khi … thì …
- **FR-002**: Hệ thống MUST …
  - Tiêu chí chấp nhận: Khi … thì …

### Key Entities

Chỉ khi có dữ liệu mới: tên thực thể, trường chính, quan hệ.

## Success Criteria

- **SC-001**: Số đo kiểm được (thời gian, tỉ lệ, số bước).

## Assumptions

Điều đang coi là đúng và ai xác nhận.
`;

const PLAN_TEMPLATE = `# Plan: tên hạng mục

## Summary

Hướng làm trong vài câu, nối với spec.

## Technical Context

Ngôn ngữ, thư viện, lưu trữ, cách test, nền tảng chạy; điều chưa biết ghi rõ để research.

## Constitution Check

Từng nguyên tắc trong constitution: đạt / ngoại lệ có lý do.

## Project Structure

### Documentation

File tài liệu của hạng mục.

### Source Code

Cây thư mục sẽ đổi hoặc thêm, mỗi nhánh một dòng giải thích.

## Complexity Tracking

Chỉ khi có ngoại lệ ở Constitution Check: ngoại lệ gì, vì sao cần, phương án đơn giản hơn đã bỏ vì sao.
`;

const RESEARCH_TEMPLATE = `# Research

## Câu hỏi đã tìm hiểu

- Câu hỏi → quyết định, phương án đã cân nhắc, vì sao chọn.
`;

const DATA_MODEL_TEMPLATE = `# Data model

## Thực thể

- Tên: trường, kiểu, ràng buộc, quan hệ.
`;

const TASKS_TEMPLATE = `# Tasks: tên hạng mục

Mỗi phần (\`## Phase\`) là một đơn vị giao việc: một run, một PR. Dòng \`T###\` bên dưới là checklist của phần đó.

<!--
  Cách ghi:
  - \`[P]\`: chạy song song được; \`[US1]\`: thuộc User Story 1.
  - Phụ thuộc ghi ở mục Dependencies: "T003 phụ thuộc T001, T002".
  - Hạng mục nhiều dự án: thêm thẻ dự án cuối dòng task, ví dụ
    "- [ ] T004 [US1] Gọi API hoàn tiền từ màn đơn hàng [@web-shop]".
    Task không có thẻ thuộc dự án chính. Khoá dự án phải nằm trong danh sách dự án tham gia.
-->

## Phase 1: Nền

- [ ] T001 Tạo bảng và migration cho …
- [ ] T002 [P] Thêm kiểu dữ liệu vào contract …

## Phase 2: User Story 1 - Tên ngắn

- [ ] T003 [US1] Viết test cho …
- [ ] T004 [US1] Cài đặt …

## Dependencies

- T003 phụ thuộc T001, T002
- T004 phụ thuộc T003
`;

const SPECIFY_PROMPT = `Bạn viết spec (đặc tả) cho một hạng mục theo cách làm của Spec Kit: nói điều gì cần có và vì sao, chưa nói làm thế nào.
Nếu repo có skill \`speckit-specify\` thì dùng nó; không thì làm theo hướng dẫn dưới đây.

Ý tưởng của người giao:
{idea}

Hiến pháp của dự án (nguyên tắc phải tuân theo):
{constitution}

Bối cảnh đã có (tài liệu, câu trả lời, góp ý của người duyệt):
{artifacts}
{answers}
{feedback}

Hạng mục nhiều dự án thì đọc tóm tắt các repo tham gia:
{projects}

Cách làm:
1. Đọc repo và các spec cũ trong \`specs/\` để dùng đúng thuật ngữ và không viết lại điều đã có.
2. Viết User Story theo thứ tự ưu tiên; mỗi câu chuyện kiểm riêng được và có Acceptance Scenarios dạng Given/When/Then.
3. Mỗi yêu cầu là một dòng \`FR-nnn\` (ba chữ số) có tiêu chí chấp nhận. Chỉ nói hành vi nhìn thấy được, không nêu công nghệ.
4. Success Criteria là số đo kiểm được, không phụ thuộc cách cài đặt.
5. Chỗ chưa rõ mà đổi hướng làm việc thì gọi \`sdlc_ask\` (tối đa 5 câu mỗi vòng, mỗi câu kèm đề xuất). Chưa có trả lời thì để
   \`[NEEDS CLARIFICATION: câu hỏi]\` đúng chỗ đó; điều đoán được hợp lý thì ghi vào Assumptions, không hỏi.
6. Có câu trả lời thì ghi quyết định vào mục Clarifications và xoá dấu đã giải quyết.
7. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

const PLAN_PROMPT = `Bạn viết kế hoạch kỹ thuật (plan) cho spec đã duyệt, theo cách làm của Spec Kit: chọn cách làm và kiểm nó với hiến pháp.
Nếu repo có skill \`speckit-plan\` thì dùng nó; không thì làm theo hướng dẫn dưới đây.

Spec đã duyệt và bối cảnh:
{artifacts}

Hiến pháp của dự án:
{constitution}

Câu trả lời và góp ý:
{answers}
{feedback}

Các repo tham gia (hạng mục nhiều dự án):
{projects}

Cách làm:
1. Đọc code hiện có chỗ sẽ đổi; ưu tiên tái dùng hơn viết mới. Nêu rõ file và module sẽ đụng ở Project Structure.
2. Constitution Check: đi qua từng nguyên tắc, ghi đạt hay ngoại lệ. Có ngoại lệ thì giải thích ở Complexity Tracking, không giấu.
3. Điều chưa biết ở Technical Context thì tìm hiểu rồi ghi vào research.md; quyết định kèm phương án đã bỏ.
4. Thực thể mới thì ghi data-model.md. Hạng mục nhiều dự án: khi hai repo phải thống nhất giao diện (API, sự kiện, schema), viết
   mỗi giao diện thành một contract rồi báo bằng \`sdlc_report\` loại \`contracts\` (tên, định dạng, bên cung cấp, bên dùng).
5. Mọi \`FR-nnn\` của spec phải có chỗ trong plan; điều spec chưa đủ để quyết thì gọi \`sdlc_ask\` (tối đa 3 câu).
6. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

const TASKS_PROMPT = `Bạn chia plan đã duyệt thành danh sách task theo cách làm của Spec Kit.
Nếu repo có skill \`speckit-tasks\` thì dùng nó; không thì làm theo hướng dẫn dưới đây và theo đúng khuôn tasks.md đã cho.

Spec, plan, contract đã duyệt:
{artifacts}

Góp ý của người duyệt:
{feedback}

Các repo tham gia (hạng mục nhiều dự án):
{projects}

Cách làm:
1. Mỗi \`## Phase\` là một đơn vị giao việc cho một agent trong một PR, nằm trong một repo; việc nhỏ hơn là dòng \`T###\` bên trong.
   Không quá 12 phần; gộp theo luồng người dùng hay module, không theo từng file.
2. Mỗi dòng \`T###\` nêu việc và đường dẫn file cụ thể, gắn \`[USn]\` khi thuộc một User Story; \`[P]\` chỉ khi không đụng file của dòng khác.
3. Test của một story đứng trước phần cài đặt của story đó. Phụ thuộc ghi ở mục Dependencies: "T004 phụ thuộc T003".
4. Mỗi \`FR-nnn\` của spec phải xuất hiện trong ít nhất một task (ghi mã trong dòng hoặc ở tiêu đề phần). Thiếu thì thêm task, không bỏ yêu cầu.
5. Hạng mục nhiều dự án: gắn thẻ dự án \`[@khoá-dự-án]\` cuối dòng task thuộc repo khác dự án chính; phụ thuộc giữa hai repo
   ghi như phụ thuộc thường. Contract phải xong trước task dùng nó.
6. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

const ANALYZE_PROMPT = `Bạn đọc chéo spec, plan và tasks của hạng mục như một người duyệt độc lập (không phải người đã viết), rồi báo phát hiện.
Nếu repo có skill \`speckit-analyze\` thì dùng nó; không thì làm theo hướng dẫn dưới đây. Không sửa file nào.

Tài liệu của hạng mục:
{artifacts}

Cách làm:
1. Tìm: yêu cầu \`FR-nnn\` không có task; task không truy về yêu cầu nào; plan mâu thuẫn spec; thuật ngữ đổi nghĩa giữa các
   tài liệu; phụ thuộc thiếu hoặc vòng; vi phạm hiến pháp.
2. Mỗi phát hiện có mức (critical, major, minor), vị trí (file, mục) và cách sửa ngắn gọn.
3. Báo bằng \`sdlc_report\` loại \`analysis\`. Không có phát hiện thì báo danh sách rỗng, đừng bịa.`;

const CONVERGE_PROMPT = `Bạn đối chiếu spec đã duyệt với code đang ở nhánh mặc định để xem còn yêu cầu nào chưa làm hoặc làm lệch.
Nếu repo có skill \`speckit-converge\` thì dùng nó; không thì làm theo hướng dẫn dưới đây. Không sửa file nào.

Tài liệu của hạng mục:
{artifacts}

Cách làm:
1. Với mỗi \`FR-nnn\`, tìm code và test thực hiện nó rồi kết luận: met (đạt), partial (một phần), missing (chưa có), diverged (làm khác spec).
2. Mỗi kết luận kèm bằng chứng: file và dòng, tên test. Không có bằng chứng thì là missing, không đoán.
3. Báo bằng \`sdlc_report\` loại \`findings\`; chỉ liệt kê phần chưa đạt đủ để hub đề xuất task bổ sung.`;

export const speckit = sdlcMode.parse({
  id: "speckit",
  name: "Spec Kit",
  description:
    "Cỡ M–L: spec, plan, tasks, mỗi bước có cổng duyệt; tasks tách thành task có phụ thuộc; hỗ trợ nhiều dự án và contract liên repo.",
  method: "speckit",
  profile: "feature",
  // Có cỡ L nên là chế độ nặng: giai đoạn Specify luôn cần người duyệt (D26).
  sizes: ["M", "L"],
  phases: [
    {
      id: "specify",
      name: "Specify",
      kind: "requirements",
      artifacts: [
        {
          id: "spec",
          name: "spec.md",
          path: "specs/{NNN}-{slug}/spec.md",
          sections: SPEC_SECTIONS,
          template: SPEC_TEMPLATE,
        },
      ],
      steps: [
        { id: "draft-spec", action: "draft", artifacts: ["spec"], skill: "speckit-specify", prompt: SPECIFY_PROMPT },
      ],
      gate: [
        {
          name: "Duyệt spec",
          outputs: ["spec.md"],
          gates: [
            {
              id: "rules",
              name: "Đủ mục, mỗi yêu cầu có tiêu chí, hết câu hỏi mở",
              kind: "rule",
              rules: ["sections", "requirements", "no-open-questions"],
              sections: SPEC_SECTIONS,
            },
            {
              id: "po",
              name: "PO duyệt spec",
              kind: "human",
              reviewers: { users: [], roles: ["team-ba", "team-admin"], quorum: 1 },
              slaHours: 24,
            },
          ],
        },
      ],
    },
    {
      id: "plan",
      name: "Plan",
      kind: "design",
      artifacts: [
        {
          id: "plan",
          name: "plan.md",
          path: "specs/{NNN}-{slug}/plan.md",
          sections: PLAN_SECTIONS,
          template: PLAN_TEMPLATE,
        },
        {
          id: "research",
          name: "research.md",
          path: "specs/{NNN}-{slug}/research.md",
          required: false,
          template: RESEARCH_TEMPLATE,
        },
        {
          id: "data-model",
          name: "data-model.md",
          path: "specs/{NNN}-{slug}/data-model.md",
          required: false,
          template: DATA_MODEL_TEMPLATE,
        },
        // Hai đội phải đồng ý trước khi cùng cài đặt (D23): cổng riêng, không bao giờ tự duyệt.
        {
          id: "contract",
          name: "Contract liên repo",
          path: "specs/{NNN}-{slug}/contracts/{name}.{ext}",
          required: false,
          scope: "contract",
          repeatable: true,
        },
      ],
      steps: [
        {
          id: "draft-plan",
          action: "draft",
          artifacts: ["plan", "research", "data-model", "contract"],
          skill: "speckit-plan",
          maxQuestions: 3,
          prompt: PLAN_PROMPT,
        },
      ],
      gate: [
        {
          name: "Duyệt plan",
          outputs: ["plan.md", "research.md", "data-model.md"],
          gates: [
            {
              id: "rules",
              name: "Đủ mục của plan",
              kind: "rule",
              rules: ["sections", "no-open-questions"],
              sections: PLAN_SECTIONS,
            },
            {
              id: "ai-plan",
              name: "AI đối chiếu constitution",
              kind: "ai",
              ai: {
                checks: [
                  "Plan tuân theo từng nguyên tắc trong constitution, ngoại lệ có lý do",
                  "Mọi yêu cầu FR-nnn của spec có chỗ trong plan",
                  "Không có ràng buộc mâu thuẫn nhau hay mâu thuẫn spec",
                  "Cách làm tái dùng code có sẵn thay vì viết lại",
                ],
                passScore: 8,
              },
            },
            {
              id: "lead",
              name: "Tech lead duyệt plan",
              kind: "human",
              reviewers: { users: [], roles: ["team-admin"], quorum: 1 },
              slaHours: 24,
            },
          ],
        },
      ],
      perProjectGates: ["lead"],
      autoApprove: { gates: ["lead"], minScore: 9, revokeHours: 24 },
    },
    {
      id: "tasks",
      name: "Tasks",
      kind: "decomposition",
      artifacts: [{ id: "tasks", name: "tasks.md", path: "specs/{NNN}-{slug}/tasks.md", template: TASKS_TEMPLATE }],
      steps: [
        {
          id: "draft-tasks",
          action: "draft",
          artifacts: ["tasks"],
          skill: "speckit-tasks",
          maxQuestions: 2,
          prompt: TASKS_PROMPT,
        },
        // Đọc chéo bằng CLI khác với CLI soạn để không tự chấm bài mình; kết quả vào checkpoint AI của cổng.
        {
          id: "analyze-tasks",
          action: "analyze",
          artifacts: ["spec", "plan", "tasks"],
          cli: "codex",
          maxQuestions: 0,
          prompt: ANALYZE_PROMPT,
        },
      ],
      gate: [
        {
          name: "Duyệt bản tách task",
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
              name: "AI đọc chéo spec, plan, tasks",
              kind: "ai",
              ai: {
                checks: [
                  "Mỗi task truy về một yêu cầu và nêu file cụ thể",
                  "Thứ tự và phụ thuộc hợp lý, test đứng trước cài đặt",
                  "Mỗi phần giao được cho một run và một PR",
                ],
                passScore: 8,
              },
            },
            {
              id: "lead",
              name: "Tech lead duyệt bản tách",
              kind: "human",
              reviewers: { users: [], roles: ["team-admin"], quorum: 1 },
              slaHours: 24,
            },
          ],
        },
      ],
      perProjectGates: ["lead"],
      autoApprove: { gates: ["lead"], minScore: 9, revokeHours: 24 },
    },
    { id: "implement", name: "Implement", kind: "implementation" },
    {
      id: "converge",
      name: "Converge",
      kind: "verification",
      optional: true,
      steps: [
        {
          id: "converge-spec",
          action: "converge",
          artifacts: ["spec", "plan", "tasks"],
          auto: false,
          maxQuestions: 0,
          skill: "speckit-converge",
          prompt: CONVERGE_PROMPT,
        },
      ],
    },
  ],
  decomposition: {
    phase: "tasks",
    artifact: "tasks",
    parser: "speckit-tasks",
    // Bài học bản v1: 58 dòng T### thành 58 task hub là quá mịn; mỗi phần là một task, dòng T### là checklist.
    granularity: "heading",
    requirementId: "FR-\\d{3}",
    requirementSource: [{ phase: "specify", artifact: "spec" }],
    maxTasks: 30,
    maxChecklist: 20,
  },
  blocking: "hard",
  converge: { maxRounds: 2 },
  maxAgentRevisions: 2,
});
