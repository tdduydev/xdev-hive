import { type AgentMemoryPolicy, BRIEF_MAX_CHARS } from "@xdev-hive/contracts";

// Brief của dự án trong prompt (ADR 0022). Số đo 7 ngày: phần lớn chi phí run nằm trước lần sửa đầu tiên, agent dò
// repo bằng ls/find/cat; brief và chỉ dẫn dưới đây cho agent bản đồ có sẵn để đi thẳng tới file cần sửa.

/** Run brief đi trên nhánh `brief/<dự án>`; index runs_brief_active lọc theo tiền tố này. */
export const briefBranch = (projectKey: string) => `brief/${projectKey}`;

export interface BriefForPrompt {
  content: string;
  commitSha: string | null;
  source: "agent" | "user";
  headSha: string | null;
  commitsBehind: number | null;
}

const short = (sha: string) => sha.slice(0, 12);

/** Prompt của run brief: đọc repo ở nhánh chính và nộp bản tóm tắt qua `brief_submit`. */
export function briefRunPrompt(opts: { projectKey: string; baseBranch: string; current: BriefForPrompt | null }) {
  const lines = [
    `Bạn viết bản tóm tắt repo (brief) cho dự án ${opts.projectKey}. Brief được đặt đầu prompt của mọi run sau này để`,
    "agent khỏi phải khảo sát lại cả repo, nên phải đúng, gọn và có đường dẫn cụ thể.",
    "",
    `Worktree đang ở nhánh chính ${opts.baseBranch}, chế độ chỉ đọc. Không sửa file, không commit, không push.`,
    "",
    "Brief gồm (Markdown, tối đa khoảng 3.000 token):",
    "1. Mục đích của repo trong vài câu.",
    "2. Cấu trúc: thư mục chính và module, mỗi dòng một chỗ, nói nó chứa gì; file lõi và file rất dài nên đọc theo đoạn.",
    "3. Lệnh cài đặt, build, test, lint, chạy tại máy (đúng như repo dùng: package.json, Makefile, go.mod, CI).",
    "4. Quy ước quan trọng: cách import, đặt tên, ranh giới module, ngôn ngữ của chữ trên giao diện, quy tắc commit.",
    "5. Chỗ hay bẫy: điều agent dễ làm sai, bước bắt buộc sau khi đổi một loại file.",
    "",
    "Cách đọc: README, AGENTS.md/CLAUDE.md, tài liệu kiến trúc, file cấu hình build và CI, danh sách thư mục hai cấp.",
    "Không đọc từng file nguồn; chỉ mở file khi cần xác nhận một điều sẽ ghi vào brief.",
    "",
    "Khi xong, gọi tool MCP `brief_submit` của xdev-hive đúng một lần với `content` (brief, tối đa",
    `${BRIEF_MAX_CHARS} ký tự) và \`commitSha\` (kết quả của \`git rev-parse HEAD\` trong worktree). Không gọi thì brief`,
    "không được lưu.",
  ];
  const c = opts.current;
  if (c) {
    lines.push(
      "",
      `Brief hiện tại${c.commitSha ? ` (viết ở commit ${short(c.commitSha)})` : ""}${c.source === "user" ? ", người trong đội đã sửa tay" : ""}:`,
      "<<<BRIEF",
      c.content,
      "BRIEF",
      "",
      "Cập nhật theo repo hiện tại: giữ phần còn đúng (nhất là phần người viết tay), sửa phần đã sai, thêm phần mới.",
    );
  }
  return lines.join("\n");
}

/**
 * Khối đặt trước prompt của run làm việc trên repo. Đặt trước chứ không sau: phần đầu prompt giống nhau giữa các run
 * của cùng dự án nên CLI dùng lại được prompt cache.
 */
export function briefBlock(
  brief: BriefForPrompt | null,
  opts: { memorySearch: boolean; memoryWrite: AgentMemoryPolicy | null },
): string {
  const lines: string[] = [];
  if (brief) {
    lines.push(
      `# Brief của dự án${brief.commitSha ? ` (bản tóm tắt repo, viết ở commit ${short(brief.commitSha)})` : ""}`,
      "",
      brief.content,
      "",
    );
  }
  lines.push(
    "# Cách khảo sát repo",
    ...(brief ? ["- Đọc brief trên trước khi mở file nào."] : []),
    ...(opts.memorySearch
      ? ["- Gọi tool MCP `memory_search` của xdev-hive với từ khoá của việc để biết quyết định, quy ước, bẫy đã ghi."]
      : []),
    "- Chỉ mở file liên quan tới việc. Không chạy ls -R, find, cat, grep trên cả repo; tìm bằng rg trong thư mục cụ",
    "  thể, đọc file dài theo đoạn.",
  );
  if (brief) {
    lines.push("- Brief có thể cũ: code khác brief thì tin code.");
    if (brief.commitSha && brief.headSha && brief.headSha !== brief.commitSha && (brief.commitsBehind ?? 0) > 0) {
      lines.push(
        `- Brief viết ở commit ${short(brief.commitSha)}; nhánh chính đã tới ${short(brief.headSha)}, đi trước ${brief.commitsBehind} commit.`,
      );
    }
  }
  if (opts.memoryWrite) {
    lines.push(
      `- Gặp quyết định, quy ước hay cái bẫy đáng nhớ mà brief và memory chưa có thì ghi bằng \`memory_write\` (tối đa ${opts.memoryWrite.maxPerRun}`,
      `  mục mỗi run, mỗi mục vài câu, kèm file liên quan${opts.memoryWrite.mode === "propose" ? "; người trong đội duyệt rồi mới dùng" : ""}).`,
      "  Không ghi điều đã có trong brief hay điều chỉ đúng cho task này.",
    );
  }
  return lines.join("\n");
}
