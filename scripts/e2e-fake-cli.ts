// CLI giả thay "claude" khi chạy scripts/e2e-smoke.ts (qua HIVE_WORKER_CLI_OVERRIDES của worker): sửa README, commit,
// rồi báo cáo bằng tool MCP task_update như agent thật. Nhờ vậy kiểm được luồng worker → hub → PR mà không gọi AI.
// Worker chạy: node scripts/e2e-fake-cli.ts "<prompt>" trong worktree của run.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const prompt = process.argv[2] ?? "";
// Máy CI không có danh tính git global; đặt qua biến môi trường để không đụng cấu hình của worktree.
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Agent giả e2e",
  GIT_AUTHOR_EMAIL: "agent@hive-e2e.invalid",
  GIT_COMMITTER_NAME: "Agent giả e2e",
  GIT_COMMITTER_EMAIL: "agent@hive-e2e.invalid",
};
const git = (...args: string[]) => execFileSync("git", args, { env: gitEnv, encoding: "utf8" }).trim();

console.log(`[cli giả] nhận việc: ${prompt.split("\n")[0]}`);
appendFileSync("README.md", `\n## Ghi chú của agent giả\n\n${prompt}\n`);
git("add", "README.md");
git("commit", "--quiet", "-m", "docs: ghi chú của agent giả (e2e)");
const sha = git("rev-parse", "HEAD");
console.log(`[cli giả] đã commit ${sha}`);

/** Lời gọi JSON-RPC tới cổng /mcp (stateless); hub trả JSON hoặc một sự kiện SSE tuỳ header Accept. */
async function callTool(hub: string, token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(new URL("/mcp", hub), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const payload = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("")
    : text;
  const msg = JSON.parse(payload) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
    error?: { message: string };
  };
  if (msg.error) throw new Error(msg.error.message);
  const out = msg.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
  if (msg.result?.isError) throw new Error(out);
  return out;
}

// Worker đặt hai biến này cho CLI của run (worker/internal/channel).
const { HIVE_RUN_TOKEN: token, HIVE_HUB_URL: hub } = process.env;
if (token && hub) {
  try {
    const out = await callTool(hub, token, "task_update", {
      status: "review",
      note: `Agent giả đã thêm ghi chú vào README.md (commit ${sha.slice(0, 12)}).`,
    });
    console.log(`[cli giả] đã báo cáo qua MCP: ${out}`);
  } catch (e) {
    // Không làm run lỗi: agent thật cũng chạy tiếp khi MCP hỏng; e2e-smoke kiểm báo cáo ở bước riêng.
    console.error(`[cli giả] không báo cáo được qua MCP: ${e instanceof Error ? e.message : String(e)}`);
  }
} else {
  console.log("[cli giả] không có HIVE_RUN_TOKEN hoặc HIVE_HUB_URL, bỏ qua báo cáo MCP");
}
