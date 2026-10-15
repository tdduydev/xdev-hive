import { runLogChunk } from "@xdev-hive/contracts";
import * as vscode from "vscode";
import { errorMessage, streamRun } from "@/hub/index.ts";
import { addStrings, t } from "@/lib/i18n.ts";
import { redact } from "@/lib/redact.ts";
import { allPages } from "@/views/approvals.ts";
import { type Command, type Connection, HubTree, leaf, type Node } from "@/views/mine.ts";

addStrings(
  {
    "tree.planning": "Đang lập kế hoạch",
    "tree.leased": "Đã nhận việc",
    "tree.preparing": "Đang chuẩn bị",
    "tree.awaiting_input": "Chờ trả lời",
    "tree.verifying": "Đang kiểm tra",
    "tree.succeeded": "Thành công",
    "tree.no_changes": "Không có thay đổi",
    "tree.needs_review": "Cần xem lại",
    "tree.lost": "Mất kết nối",
    "tree.cancelling": "Đang huỷ",
  },
  {
    "tree.planning": "Planning",
    "tree.leased": "Leased",
    "tree.preparing": "Preparing",
    "tree.awaiting_input": "Awaiting input",
    "tree.verifying": "Verifying",
    "tree.succeeded": "Succeeded",
    "tree.no_changes": "No changes",
    "tree.needs_review": "Needs review",
    "tree.lost": "Lost connection",
    "tree.cancelling": "Cancelling",
  },
);

export class RunsTree extends HubTree {
  private readonly output = vscode.window.createOutputChannel(`xDev Hive · ${t("tree.run")}`);
  private stream: AbortController | undefined;
  private runId: string | undefined;
  constructor() {
    super("xdev-hive.runs");
  }

  protected async load({ client, signal }: Connection): Promise<Node[]> {
    const runs = await allPages((cursor) => client.rpc.runs.search({ mine: true, limit: 100, cursor }, { signal }));
    return runs.map((run) => {
      const node = leaf(run.id, `${run.taskKey} · ${run.taskTitle}`, "run", "xdevHive.run.openLog");
      node.description = t(`tree.${run.state}`);
      if (node.command) node.command.arguments = [node];
      return node;
    });
  }

  commands(command: Command): void {
    command("xdevHive.run.openLog", async (node, connection) => {
      if (!this.owns(node, connection)) return;
      this.output.show(true);
      if (this.runId === node.id && this.stream && !this.stream.signal.aborted) return;
      this.stop();
      const controller = new AbortController();
      this.stream = controller;
      this.runId = node.id;
      this.output.clear();
      this.output.appendLine(String(node.label));
      // Giữ byte UTF-8 và dòng dở qua các sự kiện; che token kể cả khi bị cắt giữa hai chunk.
      const decoder = new TextDecoder();
      let pending = "";
      const flush = (text: string, end = false) => {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) this.output.appendLine(redact(line));
        if (end && pending) {
          this.output.appendLine(redact(pending));
          pending = "";
        }
      };
      void streamRun(
        connection.client,
        node.id,
        (event) => {
          if (controller.signal.aborted) return;
          if (event.event === "log") {
            const chunk = runLogChunk.parse(JSON.parse(event.data));
            flush(decoder.decode(Buffer.from(chunk.bytes, "base64"), { stream: true }));
          } else if (event.event === "end") {
            flush(decoder.decode(), true);
            this.output.appendLine(t("tree.runEnd"));
          }
        },
        { signal: controller.signal },
      )
        .catch((error) => {
          if (!controller.signal.aborted) this.output.appendLine(errorMessage(error));
        })
        .finally(() => {
          if (this.stream === controller) {
            this.stream = undefined;
            this.runId = undefined;
          }
        });
    });
  }

  stop(): void {
    this.stream?.abort();
    this.stream = undefined;
    this.runId = undefined;
  }
  override reset(message?: string): void {
    this.stop();
    this.output.clear();
    super.reset(message);
  }
  override dispose(): void {
    this.stop();
    this.output.dispose();
    super.dispose();
  }
}
