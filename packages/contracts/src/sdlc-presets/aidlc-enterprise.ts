import { sdlcMode } from "../sdlc.ts";
import {
  AI_DESIGN_CHECKS,
  AI_REQUIREMENTS_CHECKS,
  AI_UNITS_CHECKS,
  AIDLC_LEAD,
  AIDLC_PO,
  AIDLC_RECORD,
  DESIGN_PROMPT,
  DESIGN_SECTIONS,
  designArtifacts,
  INTENT_PROMPT,
  intentArtifact,
  operationPhase,
  REQUIREMENT_SECTIONS,
  REQUIREMENTS_PROMPT,
  requirementsArtifact,
  storiesArtifact,
  UNITS_PROMPT,
  unitsArtifacts,
  unitsDecomposition,
  verifyPhase,
} from "./aidlc-feature.ts";

/**
 * Preset `aidlc-enterprise`: như `aidlc-feature`, cho hạng mục có quy định, cỡ XL. Thêm tài liệu yêu cầu phi chức năng
 * và bảo mật, cổng Pháp chế và Bảo mật chỉ chạy khi tài liệu nhắc tới từ khoá của họ, thiết kế cần hai người duyệt. Không
 * giai đoạn nào tự duyệt.
 */

const NFR_SECTIONS = ["Hiệu năng", "Bảo mật", "Dữ liệu cá nhân", "Tuân thủ", "Khả dụng"];

const NFR_TEMPLATE = `# Yêu cầu phi chức năng và bảo mật

## Hiệu năng

- **REQ-101**: … (số đo, ngưỡng).
  - Tiêu chí chấp nhận: …

## Bảo mật

- **REQ-201**: Xác thực, phân quyền, mã hoá, nhật ký kiểm toán.
  - Tiêu chí chấp nhận: …

## Dữ liệu cá nhân

Dữ liệu nào được thu, giữ bao lâu, ai xem được.

## Tuân thủ

Quy định áp dụng (ví dụ: Nghị định 13/2023, PCI DSS) và cách đáp ứng.

## Khả dụng

Mục tiêu sẵn sàng, sao lưu, khôi phục.
`;

const NFR_PROMPT = `Bạn viết yêu cầu phi chức năng, bảo mật và tuân thủ cho hạng mục có quy định (AI-DLC Enterprise).

Bối cảnh đã có (tài liệu, câu trả lời, góp ý của người duyệt):
{artifacts}
{answers}
{feedback}

Cách làm:
1. Đọc cấu hình bảo mật, lưu trữ dữ liệu và nhật ký của repo; ghi cái đang có trước khi đề xuất thêm.
2. Mỗi yêu cầu có mã REQ-nnn (hiệu năng từ 101, bảo mật từ 201) và tiêu chí đo được.
3. Quy định áp dụng phải nêu tên và điều khoản; không chắc thì hỏi bằng \`sdlc_ask\`, chưa có trả lời thì để
   \`[NEEDS CLARIFICATION: câu hỏi]\`.
4. Chỉ ghi file tài liệu. Không sửa code, không commit.`;

// Pháp chế và Bảo mật là người cấp tổ chức, không thuộc đội của dự án nào.
const ORG_ADMIN = { users: [], roles: ["org-admin"], quorum: 1 };
const conditions = (keywords: string[]) => ({
  docTypes: [],
  keywords,
  minChangedLines: null,
  skipFormattingOnly: false,
});
const LEGAL_KEYWORDS = ["phí", "hoàn tiền", "hợp đồng", "điều khoản", "fee", "refund", "contract", "terms"];
const SECURITY_KEYWORDS = [
  "dữ liệu cá nhân",
  "mật khẩu",
  "mã hoá",
  "phân quyền",
  "PII",
  "password",
  "encryption",
  "token",
];

export const aidlcEnterprise = sdlcMode.parse({
  id: "aidlc-enterprise",
  name: "AI-DLC Enterprise",
  description:
    "Có quy định, cỡ XL: như Feature, thêm yêu cầu phi chức năng và bảo mật, Pháp chế và Bảo mật duyệt theo từ khoá, thiết kế cần hai người duyệt.",
  method: "aidlc",
  profile: "enterprise",
  sizes: ["XL"],
  phases: [
    {
      id: "ideation",
      name: "Ý tưởng",
      kind: "intake",
      artifacts: [intentArtifact],
      steps: [
        {
          id: "draft-intent",
          action: "draft",
          artifacts: ["intent"],
          maxQuestions: 3,
          prompt: INTENT_PROMPT,
        },
      ],
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
      artifacts: [
        requirementsArtifact,
        storiesArtifact,
        {
          id: "nfr",
          name: "nfr-requirements.md",
          path: `${AIDLC_RECORD}/inception/nfr-requirements/nfr-requirements.md`,
          sections: NFR_SECTIONS,
          template: NFR_TEMPLATE,
        },
      ],
      steps: [
        {
          id: "draft-requirements",
          action: "draft",
          artifacts: ["requirements", "stories"],
          prompt: REQUIREMENTS_PROMPT,
        },
        { id: "draft-nfr", action: "draft", artifacts: ["nfr"], prompt: NFR_PROMPT },
      ],
      gate: [
        {
          name: "Duyệt yêu cầu",
          outputs: ["requirements.md", "stories.md", "nfr-requirements.md"],
          gates: [
            {
              id: "rules",
              name: "Đủ mục, mỗi yêu cầu có tiêu chí, hết câu hỏi mở",
              kind: "rule",
              rules: ["sections", "requirements", "no-open-questions", "no-secrets"],
              sections: REQUIREMENT_SECTIONS,
            },
            {
              id: "ai-requirements",
              name: "AI kiểm yêu cầu đủ và kiểm được",
              kind: "ai",
              ai: {
                checks: [...AI_REQUIREMENTS_CHECKS, "Yêu cầu bảo mật và tuân thủ nêu rõ quy định áp dụng"],
                passScore: 8,
              },
            },
            { id: "po", name: "PO duyệt yêu cầu", kind: "human", reviewers: AIDLC_PO, slaHours: 24 },
            {
              id: "legal",
              name: "Pháp chế",
              kind: "human",
              reviewers: ORG_ADMIN,
              slaHours: 48,
              conditions: conditions(LEGAL_KEYWORDS),
            },
            {
              id: "security",
              name: "Bảo mật",
              kind: "human",
              reviewers: ORG_ADMIN,
              slaHours: 48,
              conditions: conditions(SECURITY_KEYWORDS),
            },
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
          prompt: `${DESIGN_PROMPT}

Bản Enterprise: mỗi yêu cầu bảo mật (REQ-2nn) phải có kiểm soát cụ thể trong thiết kế (chỗ kiểm quyền, mã hoá, nhật ký).`,
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
              rules: ["sections", "no-open-questions", "no-secrets"],
              sections: DESIGN_SECTIONS,
            },
            {
              id: "ai-design",
              name: "AI đối chiếu yêu cầu",
              kind: "ai",
              ai: { checks: [...AI_DESIGN_CHECKS, "Mỗi yêu cầu bảo mật có kiểm soát tương ứng"], passScore: 8 },
            },
            {
              id: "lead",
              name: "Kiến trúc sư duyệt thiết kế",
              kind: "human",
              reviewers: { ...AIDLC_LEAD, quorum: 2 },
              slaHours: 48,
            },
            {
              id: "security",
              name: "Bảo mật",
              kind: "human",
              reviewers: ORG_ADMIN,
              slaHours: 48,
              conditions: conditions(SECURITY_KEYWORDS),
            },
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
    },
    { id: "construction", name: "Construction", kind: "implementation" },
    verifyPhase,
    operationPhase,
  ],
  decomposition: {
    ...unitsDecomposition,
    requirementSource: [
      { phase: "requirements", artifact: "requirements" },
      { phase: "requirements", artifact: "nfr" },
    ],
  },
  blocking: "hard",
  converge: { maxRounds: 0 },
  maxAgentRevisions: 2,
});
