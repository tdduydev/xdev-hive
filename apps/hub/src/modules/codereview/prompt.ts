import type { AiReviewerResult, FindingSeverity, ReviewGate } from "@xdev-hive/contracts";

type GateAi = NonNullable<ReviewGate["ai"]>;

/**
 * Mục kiểm gửi reviewer. Agent trả `checklist` với label đúng chữ từng mục, nên mục trùng hay chỉ có khoảng trắng làm
 * hai dòng kết quả không ghép được với cấu hình.
 */
export function reviewRubric(ai: GateAi): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ai.checks) {
    const c = raw.replace(/\s+/g, " ").trim();
    if (!c || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    out.push(c);
  }
  return out;
}

/** Đường dẫn trọng tâm: chính điều kiện đường dẫn của checkpoint, vì checkpoint chỉ chạy khi diff chạm các đường dẫn đó. */
export function reviewFocus(gate: ReviewGate): string[] {
  return [...new Set((gate.conditions.paths ?? []).map((p) => p.trim()).filter(Boolean))];
}

const BLOCKED: Record<"critical" | "major", FindingSeverity[]> = {
  critical: ["critical"],
  major: ["critical", "major"],
};

/**
 * Quy tắc chấm riêng của checkpoint, thêm vào lời nhắc run review. Reviewer cần biết ngưỡng và mức chặn thật của quy
 * trình: lời nhắc review chéo mặc định coi 7 là đủ, nên với ngưỡng 8 reviewer chấm 7 vì nghĩ thế là đạt.
 */
export function reviewGuidance(ai: GateAi): string[] {
  const lines = [
    `- Ngưỡng đạt của checkpoint này là ${ai.passScore}/10${
      (ai.aggregate ?? "all") === "avg" ? " (tính trên điểm trung bình của các reviewer)" : ""
    }. Chấm đúng chất lượng của thay đổi, không nâng hay hạ điểm cho khớp ngưỡng.`,
  ];
  if (ai.blockOn)
    lines.push(
      `- Phát hiện mức ${BLOCKED[ai.blockOn].join(" hoặc ")} chặn PR dù điểm đủ: chỉ dùng mức này cho lỗi phải sửa trước khi merge, ghi rõ file và dòng.`,
    );
  return lines;
}

/** Requirement của task thuộc hạng mục AI SDLC; module `sdlc` cung cấp qua `AiGateDeps.specContextFor`. */
export interface ReviewSpecContext {
  /** Mã và tên hạng mục, ví dụ `012 · Xuất báo cáo`. */
  item: string;
  /** `text` rỗng khi không đọc được tài liệu nguồn requirement. */
  requirements: { id: string; text: string; acceptance: string[] }[];
  docs: { name: string; docKey: string; version: number }[];
}

/** Lời nhắc dài làm agent bỏ qua phần diff; hạng mục lớn thì reviewer mở tài liệu để đọc phần còn lại. */
const MAX_REQUIREMENTS = 20;
const MAX_ACCEPTANCE = 8;
const MAX_REQUIREMENT_TEXT = 500;

/**
 * Ngữ cảnh spec trong lời nhắc review (T085): reviewer chấm thay đổi có đáp ứng requirement và tiêu chí của task hay
 * không, thay vì chỉ đoán ý từ tiêu đề task.
 */
export function reviewSpecLines(spec: ReviewSpecContext): string[] {
  const lines = [`Task thuộc hạng mục AI SDLC ${spec.item}.`];
  const reqs = spec.requirements.slice(0, MAX_REQUIREMENTS);
  if (reqs.length) {
    lines.push(
      "Thay đổi phải đáp ứng các requirement sau của task (dòng thụt vào là tiêu chí chấp nhận). Requirement chưa làm, làm sai hay thiếu tiêu chí là phát hiện, ghi mã requirement trong message:",
    );
    for (const r of reqs) {
      const text = r.text.replace(/\s+/g, " ").trim();
      lines.push(`- ${r.id}${text && text !== r.id ? `: ${clip(text, MAX_REQUIREMENT_TEXT)}` : ""}`);
      for (const a of r.acceptance.slice(0, MAX_ACCEPTANCE))
        lines.push(`  - ${clip(a.replace(/\s+/g, " ").trim(), MAX_REQUIREMENT_TEXT)}`);
    }
    if (spec.requirements.length > reqs.length)
      lines.push(`- … và ${spec.requirements.length - reqs.length} requirement khác, xem trong tài liệu.`);
  }
  if (spec.docs.length) {
    lines.push("Tài liệu đã duyệt của hạng mục (đọc bằng MCP doc_get theo key khi cần):");
    for (const d of spec.docs) lines.push(`- ${d.name} v${d.version}: key \`${d.docKey}\``);
  }
  return lines;
}

// ---- Bình luận tổng hợp lên PR ---------------------------------------------------------------------------------------

/** Như review chéo: PR dài vẫn đọc được, phần còn lại xem trên hub. */
const MAX_COMMENT_FINDINGS = 20;
const MAX_SUMMARY = 4000;
const MAX_MESSAGE = 1000;

const SEVERITY: Record<FindingSeverity, string> = {
  critical: "🔴 nghiêm trọng",
  major: "🟠 lớn",
  minor: "🟡 nhỏ",
  info: "🔵 ghi chú",
};

/** Ô bảng Markdown: `|` hay xuống dòng làm vỡ bảng. */
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const who = (r: Pick<AiReviewerResult, "cli" | "model">) => (r.model ? `${r.cli} (${r.model})` : r.cli);

export interface AiCommentInput {
  gateName: string;
  workflowName: string;
  round: number;
  headSha: string;
  passScore: number;
  aggregate: "all" | "avg";
  status: "passed" | "failed";
  score: number | null;
  /** Lý do không đạt của checkpoint (đã gộp). */
  note: string | null;
  reviewers: AiReviewerResult[];
  /** Link tới phiên trên hub; null khi hub không cấu hình địa chỉ web. */
  link: string | null;
}

/** Một bình luận cho cả checkpoint (FR-016), không phải mỗi reviewer một bình luận như review chéo cũ. */
export function aiGateComment(input: AiCommentInput): string {
  const verdict = input.status === "passed" ? "✅ đạt" : "❌ không đạt";
  const score = input.score === null ? "chưa có điểm" : `${input.score}/10`;
  const how = input.aggregate === "avg" ? "điểm trung bình" : "mọi reviewer";
  const lines = [
    `### Review AI “${input.gateName}”: ${verdict} (${score}, ngưỡng ${input.passScore} theo ${how})`,
    "",
    `Quy trình ${input.workflowName}, vòng ${input.round}, commit \`${input.headSha.slice(0, 7)}\`.`,
    "",
    "| Reviewer | Điểm | Kết quả |",
    "|---|---|---|",
    ...input.reviewers.map((r) => {
      const result = r.state === "error" ? `lỗi: ${r.error ?? "không có kết quả"}` : r.passed ? "đạt" : "không đạt";
      return `| ${cell(who(r))} | ${r.score === null ? "—" : `${r.score}/10`} | ${cell(clip(result, 200))} |`;
    }),
  ];
  if (input.status === "failed" && input.note) lines.push("", `**Lý do:** ${clip(input.note, MAX_SUMMARY)}`);

  let budget = MAX_COMMENT_FINDINGS;
  let hidden = 0;
  for (const r of input.reviewers) {
    if (r.state !== "done") continue;
    lines.push("", `**${who(r)}**${r.summary ? `: ${clip(r.summary, MAX_SUMMARY)}` : ""}`);
    const failed = r.checklist.filter((c) => !c.passed);
    for (const c of failed) lines.push(`- ☐ ${c.label}${c.note ? `: ${clip(c.note, MAX_MESSAGE)}` : ""}`);
    const shown = r.findings.slice(0, budget);
    budget -= shown.length;
    hidden += r.findings.length - shown.length;
    for (const f of shown) {
      const at = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`- ${SEVERITY[f.severity]} \`${at}\`: ${clip(f.message, MAX_MESSAGE)}`);
    }
  }
  if (hidden) lines.push("", `… và ${hidden} phát hiện khác, xem trong phiên review trên Hive.`);
  if (input.link) lines.push("", `[Mở phiên review trên Hive](${input.link})`);
  return lines.join("\n");
}
