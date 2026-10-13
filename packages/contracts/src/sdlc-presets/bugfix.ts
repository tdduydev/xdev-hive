import { sdlcMode } from "../sdlc.ts";

/**
 * Preset `bugfix`: lỗi đã biết, cỡ S. Một tài liệu ngắn (hiện tượng → cách sửa) thay cho cả bộ spec, rồi một task.
 * Tham khảo: mẫu bug report/RCA ngắn của nhóm kỹ thuật; hướng "bugfix spec" của Kiro (hiện trạng, hành vi mong đợi,
 * hành vi cần giữ). Phần chữ do Hive tự viết, không chép từ công cụ nào.
 */

const SECTIONS = ["Hiện tượng", "Tái hiện", "Nguyên nhân", "Cách sửa", "Test hồi quy"];

const TEMPLATE = `# Sửa lỗi

## Hiện tượng

Người dùng thấy gì, ở đâu, từ khi nào. Nêu hành vi mong đợi bên cạnh hành vi thực tế.

## Tái hiện

1. Bước một.
2. Bước hai.

Kết quả thực tế: …
Kết quả mong đợi: …

## Nguyên nhân

Nguyên nhân gốc, kèm file và hàm liên quan. Ghi rõ nếu mới là giả thuyết.

## Cách sửa

Mỗi dòng dưới đây thành một mục checklist của task:

- [ ] Sửa …
- [ ] Giữ nguyên hành vi …

## Test hồi quy

Test thất bại trước khi sửa và xanh sau khi sửa: tên test, file.
`;

const DRAFT_PROMPT = `Bạn viết tài liệu sửa lỗi cho hạng mục này. Mục tiêu là một trang ngắn đủ để người khác duyệt và một agent khác sửa.

Mô tả lỗi:
{idea}

Bối cảnh đã có (tài liệu, câu trả lời, góp ý của người duyệt):
{artifacts}
{answers}
{feedback}

Cách làm:
1. Đọc repo để tìm nguyên nhân gốc. Không đoán: chưa chắc thì ghi "giả thuyết" và nêu cách kiểm.
2. Điền đủ các mục của khuôn. "Cách sửa" là danh sách \`- [ ]\` nhỏ, mỗi mục kiểm được; không viết lại cả module.
3. "Test hồi quy" nêu test sẽ thất bại khi lỗi còn, không chỉ test chạy qua.
4. Thiếu thông tin mà không đọc ra được từ repo (cách tái hiện, hành vi đúng là gì) thì gọi \`sdlc_ask\`; chỉ hỏi điều
   chặn việc sửa. Chưa trả lời được thì để dấu \`[NEEDS CLARIFICATION: câu hỏi]\` đúng chỗ đó.
5. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

export const bugfix = sdlcMode.parse({
  id: "bugfix",
  name: "Sửa lỗi",
  description:
    "Lỗi đã biết, việc nhỏ: một tài liệu ngắn (hiện tượng, nguyên nhân, cách sửa), tech lead duyệt, một task.",
  method: "hive",
  profile: "bugfix",
  sizes: ["S"],
  phases: [
    {
      id: "fix",
      name: "Sửa lỗi",
      kind: "requirements",
      artifacts: [
        {
          id: "bugfix",
          name: "bugfix.md",
          path: "fixes/{NNN}-{slug}/bugfix.md",
          sections: SECTIONS,
          template: TEMPLATE,
        },
      ],
      steps: [{ id: "draft-bugfix", action: "draft", artifacts: ["bugfix"], maxQuestions: 3, prompt: DRAFT_PROMPT }],
      gate: [
        {
          name: "Duyệt bugfix.md",
          outputs: ["bugfix.md"],
          gates: [
            {
              id: "rules",
              name: "Đủ mục, hết câu hỏi mở",
              kind: "rule",
              rules: ["sections", "no-open-questions"],
              sections: SECTIONS,
            },
            {
              id: "ai-bugfix",
              name: "AI kiểm nguyên nhân và cách sửa",
              kind: "ai",
              ai: {
                checks: [
                  "Nguyên nhân giải thích được hiện tượng, không chỉ mô tả lại hiện tượng",
                  "Cách sửa nhỏ, đúng chỗ, không đụng ngoài phạm vi lỗi",
                  "Test hồi quy thất bại khi lỗi còn và xanh khi đã sửa",
                  "Không lộ dữ liệu nhạy cảm",
                ],
                passScore: 7,
              },
            },
            {
              id: "lead",
              name: "Tech lead duyệt",
              kind: "human",
              reviewers: { users: [], roles: ["team-admin"], quorum: 1 },
              slaHours: 8,
            },
          ],
        },
      ],
      perProjectGates: ["lead"],
      // Lỗi cỡ S, đã có AI kiểm trước: đủ an toàn để bỏ qua bước người. Hạng mục bugfix mà chọn cỡ L/XL vẫn cần người.
      autoApprove: { gates: ["lead"], minScore: 8.5, revokeHours: 24 },
    },
    { id: "implement", name: "Triển khai", kind: "implementation" },
  ],
  decomposition: {
    phase: "fix",
    artifact: "bugfix",
    parser: "hive-tasks",
    granularity: "single",
    requirementId: "R-\\d+",
    requirementSource: [],
    maxTasks: 1,
    maxChecklist: 20,
  },
  blocking: "soft",
  converge: { maxRounds: 0 },
  maxAgentRevisions: 2,
});
