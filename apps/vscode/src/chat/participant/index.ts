import { execFileSync } from "node:child_process";
import { basename, isAbsolute, relative, sep } from "node:path";
import { scanSecrets } from "@xdev-hive/contracts";
import * as vscode from "vscode";
import { auth } from "@/auth/index.ts";
import { createHubClient } from "@/hub/client.ts";
import { workspaceProject } from "@/hub/project.ts";
import { config } from "@/lib/config.ts";
import { t } from "@/lib/i18n.ts";
import { log } from "@/lib/log.ts";
import { redact } from "@/lib/redact.ts";
import "@/chat/participant/strings.ts";

type Draft = { projectId: string; title: string; body: string };

function scrub(text: string): string {
  const lines = text.split(/\r?\n/);
  const blocked = new Set(scanSecrets(text).map((finding) => finding.line));
  return redact(
    lines.map((line, index) => (blocked.has(index + 1) ? "[đã ẩn dòng có thể chứa bí mật]" : line)).join("\n"),
  );
}

function contextPack(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return "";
  const folder = vscode.workspace.workspaceFolders?.find(({ uri }) => {
    const rel = relative(uri.fsPath, editor.document.uri.fsPath);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  });
  if (!folder) return "";
  const file = relative(folder.uri.fsPath, editor.document.uri.fsPath);
  if (/^(?:\.env(?:\.|$)|.*(?:secret|credential|private.?key).*)$/i.test(basename(file))) return "";
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--", file], { cwd: folder.uri.fsPath, stdio: "ignore" });
    return "";
  } catch {
    // Tệp không bị loại khỏi context, hoặc workspace chưa dùng Git.
  }
  const selection = editor.document.getText(editor.selection);
  const excerpt = selection || editor.document.getText().split(/\r?\n/).slice(0, 160).join("\n");
  return `\n\nTệp: ${file}\n\n\`\`\`\n${scrub(excerpt.slice(0, 12_000))}\n\`\`\``;
}

function client() {
  return createHubClient({ hubUrl: () => config.hubUrl() || "", auth });
}

async function projectId(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const workerPath = config.binPath();
  return workspaceProject(folder.uri.fsPath, {
    ...(workerPath ? { workerPath } : {}),
    trusted: vscode.workspace.isTrusted,
  });
}

async function draftTask(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<Draft | undefined> {
  const request = await model.sendRequest(
    [
      vscode.LanguageModelChatMessage.User(
        `Soạn JSON task bằng tiếng Việt, đúng dạng {"title":"...","description":"...","acceptance":["..."],"files":["..."]}. Chỉ trả JSON, không thực hiện hành động.\nYêu cầu: ${scrub(prompt)}${contextPack()}`,
      ),
    ],
    {},
    token,
  );
  let text = "";
  for await (const part of request.text) text += part;
  try {
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as Record<string, unknown>;
    if (typeof parsed.title !== "string" || typeof parsed.description !== "string") return undefined;
    const acceptance = Array.isArray(parsed.acceptance)
      ? parsed.acceptance.filter((v): v is string => typeof v === "string")
      : [];
    const files = Array.isArray(parsed.files) ? parsed.files.filter((v): v is string => typeof v === "string") : [];
    return {
      projectId: "",
      title: scrub(parsed.title).slice(0, 200),
      body: scrub(
        [
          parsed.description,
          acceptance.length ? `\nTiêu chí hoàn thành:\n${acceptance.map((v) => `- ${v}`).join("\n")}` : "",
          files.length ? `\nTệp liên quan:\n${files.map((v) => `- ${v}`).join("\n")}` : "",
        ].join(""),
      ),
    };
  } catch {
    return { projectId: "", title: prompt.trim().slice(0, 200) || t("chat.task.defaultTitle"), body: scrub(prompt) };
  }
}

async function completeModel(
  model: vscode.LanguageModelChat,
  prompt: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const request = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
  let text = "";
  for await (const part of request.text) text += part;
  return text;
}

export function register(ctx: vscode.ExtensionContext): void {
  const chat = vscode.chat;
  if (!chat?.createChatParticipant) return;
  const participant = chat.createChatParticipant("xdev-hive.hive", async (request, _context, response, token) => {
    const command = request.command;
    const prompt = request.prompt.trim();
    try {
      if (command === "giao") {
        if (!prompt) {
          response.markdown(t("chat.task.prompt"));
          return;
        }
        let draft: Draft | undefined;
        if (request.model) {
          try {
            draft = await draftTask(prompt, request.model, token);
          } catch (error) {
            log(`Không dùng được model soạn task: ${String(error)}`);
          }
        }
        draft ??= { projectId: "", title: prompt.slice(0, 200), body: scrub(prompt) };
        draft.projectId = (await projectId()) ?? "";
        if (!draft.projectId) {
          const projects = await client().rpc.projects.list({});
          if (projects.length === 1) draft.projectId = projects[0]!.id;
          else if (projects.length > 1) {
            const chosen = await vscode.window.showQuickPick(
              projects.map((p) => ({ label: p.name, id: p.id })),
              { placeHolder: t("chat.task.chooseProject") },
            );
            draft.projectId = chosen?.id ?? "";
          }
        }
        if (!draft.projectId) {
          response.markdown(t("chat.task.noProject"));
          return;
        }
        response.markdown(
          `**${t("chat.task.draft")}**\n\n**${draft.title}**\n\n${draft.body}\n\n${t("chat.task.confirm")}`,
        );
        response.button({
          command: "xdevHive.chat.createTask",
          title: t("chat.task.createButton"),
          arguments: [draft],
        });
        return;
      }
      if (command === "hoi") {
        if (!prompt) {
          response.markdown(t("chat.leader.prompt"));
          return;
        }
        const rpc = client().rpc;
        const project = await projectId();
        const thread = await rpc.leader.threads.create({ projectId: project ?? null, title: prompt.slice(0, 200) });
        const sent = await rpc.leader.threads.send({ id: thread.id, content: scrub(prompt) });
        if (!sent.runId) {
          response.markdown(t("chat.leader.sent"));
          return;
        }
        response.markdown(t("chat.leader.waiting"));
        const deadline = Date.now() + 5 * 60_000;
        while (!token.isCancellationRequested && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const history = await rpc.leader.threads.get({ id: thread.id });
          const answer = history.messages.find(
            (message) => message.role === "leader" && message.id !== sent.message.id,
          );
          if (answer) {
            response.markdown(scrub(answer.content));
            const pending = await rpc.leader.approvals.list({ status: "pending", threadId: thread.id });
            for (const approval of pending) {
              response.markdown(`\n\n${t("chat.leader.approval")}`);
              response.button({
                command: "xdevHive.chat.approve",
                title: t("chat.leader.approve"),
                arguments: [approval.id],
              });
              response.button({
                command: "xdevHive.chat.reject",
                title: t("chat.leader.reject"),
                arguments: [approval.id],
              });
            }
            return;
          }
        }
        response.markdown(t("chat.leader.timeout"));
        return;
      }
      if (command === "review") {
        const diff = await gitDiff(token);
        if (!diff) {
          response.markdown(t("chat.review.noDiff"));
          return;
        }
        const diffLines = diff.split(/\r?\n/);
        const safeDiff =
          scrub(diffLines.slice(0, 2_000).join("\n")) +
          (diffLines.length > 2_000 ? `\n${t("chat.review.truncated")}` : "");
        if (request.model) {
          const review = await completeModel(
            request.model,
            `Review diff này. Trả lời bằng tiếng Việt, ưu tiên lỗi cụ thể, chỉ ra tệp và dòng khi có thể.\n\n${safeDiff}`,
            token,
          );
          response.markdown(scrub(review));
        } else {
          response.markdown(t("chat.review.noModel"));
          response.button({ command: "xdevHive.openChat", title: t("chat.review.openFallback") });
        }
        return;
      }
      if (command === "trangthai") {
        const [tasks, runs] = await Promise.all([
          client().rpc.tasks.list({ mine: true }),
          client().rpc.runs.search({ mine: true, limit: 20 }),
        ]);
        response.markdown(
          `**${t("chat.status.tasks")}**\n${
            tasks
              .slice(0, 10)
              .map((item) => `- ${item.title} (${item.status})`)
              .join("\n") || t("chat.status.empty")
          }\n\n**${t("chat.status.runs")}**\n${runs.items.map((item) => `- ${item.taskTitle}: ${item.state}`).join("\n") || t("chat.status.empty")}`,
        );
      }
    } catch (error) {
      log(`Chat participant: ${String(error)}`);
      response.markdown(t("chat.error"));
    }
  });
  ctx.subscriptions.push(
    participant,
    vscode.commands.registerCommand("xdevHive.chat.approve", async (id: string) => {
      try {
        await client().rpc.leader.approvals.approve({ id });
        void vscode.window.showInformationMessage(t("chat.leader.approved"));
      } catch (error) {
        log(`Duyệt đề xuất Leader: ${String(error)}`);
        void vscode.window.showErrorMessage(t("chat.error"));
      }
    }),
    vscode.commands.registerCommand("xdevHive.chat.reject", async (id: string) => {
      try {
        const reason = await vscode.window.showInputBox({
          prompt: t("chat.leader.rejectReason"),
          ignoreFocusOut: true,
        });
        if (!reason?.trim()) return;
        await client().rpc.leader.approvals.reject({ id, reason });
        void vscode.window.showInformationMessage(t("chat.leader.rejected"));
      } catch (error) {
        log(`Từ chối đề xuất Leader: ${String(error)}`);
        void vscode.window.showErrorMessage(t("chat.error"));
      }
    }),
    vscode.commands.registerCommand("xdevHive.chat.createTask", async (draft: Draft) => {
      try {
        const rpc = client().rpc;
        const task = await rpc.tasks.create({ projectId: draft.projectId, title: draft.title, body: draft.body });
        const start = await vscode.window.showInformationMessage(t("chat.task.runPrompt"), t("chat.task.runButton"));
        if (start) await rpc.runs.start({ taskId: task.id });
        void vscode.window.showInformationMessage(t("chat.task.created", { key: task.key }));
      } catch (error) {
        log(`Tạo task từ chat: ${String(error)}`);
        void vscode.window.showErrorMessage(t("chat.error"));
      }
    }),
  );
}

async function gitDiff(token: vscode.CancellationToken): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return "";
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) =>
    execFile(
      "git",
      ["diff", "--no-ext-diff", "HEAD", "--", "."],
      { cwd: folder.uri.fsPath, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (token.isCancellationRequested || error) {
          resolve("");
          return;
        }
        resolve(stdout);
      },
    ),
  );
}
