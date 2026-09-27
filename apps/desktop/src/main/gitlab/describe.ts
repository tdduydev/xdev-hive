// Review verdicts and merge request text.

export type Verdict = "approve" | "changes" | "unknown" | "none";

/** Reads the verdict the review prompt asks for ("verdict (approve / changes needed)"). */
export function parseVerdict(summary: string | null | undefined): Verdict {
  if (!summary?.trim()) return "unknown";
  const line = /verdict\s*[:：\-–—]?\s*\**\s*([^\n]{0,60})/i.exec(summary)?.[1] ?? "";
  if (/^(changes?\s+(needed|requested|required)|request(ed)?\s+changes|reject|not\s+approved)/i.test(line)) return "changes";
  if (/^(approve[ds]?|lgtm|ship\s*it|ok\b)/i.test(line)) return "approve";
  if (/(?<!\bno\s)\bchanges?\s+(needed|requested|required)\b|\brequest(ed)?\s+changes\b/i.test(summary)) return "changes";
  if (/\b(approved?|lgtm)\b/i.test(summary)) return "approve";
  return "unknown";
}

/**
 * Agent output goes into a fenced block: GitLab does not run quick actions (/merge, /approve…) or
 * mentions inside code, so a prompt-injected summary cannot act on the MR. Lines that start with "/"
 * are indented as a second guard, and the fence is longer than any backtick run in the text.
 */
export function fence(text: string, max = 6000): string {
  const clipped = text.length > max ? `${text.slice(0, max)}\n…(đã cắt)` : text;
  const safe = clipped
    .split("\n")
    .map((l) => (/^\s*\//.test(l) ? ` ${l}` : l))
    .join("\n");
  const longest = Math.max(0, ...(safe.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}text\n${safe}\n${ticks}`;
}

export interface MrText {
  project: string;
  taskId: string;
  taskTitle: string;
  implement: { runId: string; profileId: string | null; summary: string | null } | null;
  review: { runId: string; profileId: string | null; summary: string | null; verdict: Verdict } | null;
  commits: string[];
  branch: string;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  approve: "✅ approve",
  changes: "⚠️ cần sửa",
  unknown: "❔ không rõ",
  none: "",
};

export function mrTitle(t: Pick<MrText, "taskId" | "taskTitle">, draft: boolean): string {
  const title = `${t.taskId}: ${t.taskTitle}`.replace(/\s+/g, " ").trim().slice(0, 240);
  return draft ? `Draft: ${title}` : title;
}

export function mrDescription(t: MrText): string {
  const parts = [`## Task\n\n**${t.taskId}**: ${t.taskTitle.replace(/\s+/g, " ")} (xDev Hive, dự án \`${t.project}\`, branch \`${t.branch}\`)`];
  if (t.implement) {
    parts.push(`## Agent làm task: \`${t.implement.profileId ?? "?"}\` (run ${t.implement.runId})`, fence(t.implement.summary ?? "(không có tóm tắt)"));
  }
  if (t.review) {
    parts.push(
      `## Review chéo: \`${t.review.profileId ?? "?"}\` (run ${t.review.runId}), verdict ${VERDICT_LABEL[t.review.verdict]}`,
      fence(t.review.summary ?? "(không có nội dung review)"),
    );
  }
  if (t.commits.length) parts.push(`## Commits\n\n${fence(t.commits.join("\n"), 4000)}`);
  parts.push("---\n_Tạo tự động bởi xDev Hive. Nội dung trong khung code là output của agent, chưa được người kiểm tra._");
  return parts.join("\n\n");
}
