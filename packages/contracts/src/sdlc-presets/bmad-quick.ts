import { sdlcMode } from "../sdlc.ts";

/**
 * Preset `bmad-quick`: Quick Flow của BMAD Method, cỡ S–M. Một bản spec ngắn có PO duyệt rồi làm luôn; cả hạng mục là
 * một task, checklist lấy từ mục "Tasks" của spec. Khuôn và prompt do Hive viết; đường dẫn theo quy ước Quick Flow.
 */

const SPEC_SECTIONS = ["Bối cảnh", "Thay đổi", "Tiêu chí chấp nhận", "Tasks"];

const SPEC_TEMPLATE = `# Spec

## Bối cảnh

Vấn đề, người dùng, vì sao làm bây giờ. Code liên quan đang nằm ở đâu.

## Thay đổi

- File, module sẽ đổi và đổi thế nào.

## Tiêu chí chấp nhận

- **FR1**: Given … when … then …
- **FR2**: Given … when … then …

## Tasks

- [ ] Việc cụ thể, nêu file (FR1)
- [ ] Test cho FR1, FR2
`;

const SPEC_PROMPT = `Bạn viết spec theo Quick Flow của BMAD: ngắn, đủ để một agent làm xong trong một PR.

Ý tưởng của người giao:
{idea}

Bối cảnh đã có (tài liệu, câu trả lời, góp ý của người duyệt):
{artifacts}
{answers}
{feedback}

Cách làm:
1. Đọc code gần chỗ sẽ đổi trước khi viết; nêu file thật, không đoán.
2. Mỗi tiêu chí chấp nhận có mã FRn và viết dạng Given/When/Then.
3. Mục "Tasks" là checklist \`- [ ] …\`, mỗi dòng một việc nhỏ có nhắc FRn nó phủ.
4. Việc lớn hơn một PR thì nói rõ trong "Bối cảnh" và đề xuất chuyển sang BMAD Method.
5. Điều chặn việc mà repo không trả lời được thì gọi \`sdlc_ask\`. Chưa có trả lời thì để
   \`[NEEDS CLARIFICATION: câu hỏi]\` đúng chỗ đó. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

export const bmadQuick = sdlcMode.parse({
  id: "bmad-quick",
  name: "BMAD Quick Flow",
  description: "Cỡ S–M: một bản spec ngắn có PO duyệt rồi làm, một task, chặn mềm.",
  method: "bmad",
  profile: "quick",
  sizes: ["S", "M"],
  phases: [
    {
      id: "spec",
      name: "Spec",
      kind: "requirements",
      artifacts: [
        {
          id: "spec",
          name: "SPEC.md",
          path: "specs/spec-{slug}/SPEC.md",
          sections: SPEC_SECTIONS,
          template: SPEC_TEMPLATE,
        },
      ],
      steps: [{ id: "draft-spec", action: "draft", artifacts: ["spec"], maxQuestions: 3, prompt: SPEC_PROMPT }],
      gate: [
        {
          name: "Duyệt spec",
          outputs: ["SPEC.md"],
          gates: [
            {
              id: "rules",
              name: "Đủ mục, hết câu hỏi mở",
              kind: "rule",
              rules: ["sections", "no-open-questions"],
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
      perProjectGates: ["po"],
    },
    { id: "build", name: "Build", kind: "implementation" },
  ],
  decomposition: {
    phase: "spec",
    artifact: "spec",
    parser: "bmad-stories",
    granularity: "single",
    requirementId: "N?FR\\d+",
    requirementSource: [{ phase: "spec", artifact: "spec" }],
    maxTasks: 1,
    maxChecklist: 20,
  },
  blocking: "soft",
  converge: { maxRounds: 0 },
  maxAgentRevisions: 2,
});
