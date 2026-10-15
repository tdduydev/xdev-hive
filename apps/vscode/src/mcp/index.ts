import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import * as vscode from "vscode";
import { config } from "@/lib/config.ts";
import { exec } from "@/lib/exec.ts";
import { t } from "@/lib/i18n.ts";
import { McpFiles, type Stdio, type Tool } from "@/mcp/files.ts";
import { HiveMcpProvider } from "@/mcp/provider.ts";
import { findBinary } from "@/worker/bin.ts";
import "@/mcp/strings.ts";

type CursorMcp = {
  registerServer(config: { name: string; server: Stdio & { env: Record<string, string> } }): Promise<void> | void;
  unregisterServer(name: string): Promise<void> | void;
};
function cursorApi(): CursorMcp | undefined {
  const api = (vscode as unknown as { cursor?: { mcp?: CursorMcp } }).cursor?.mcp;
  return vscode.env.uriScheme === "cursor" &&
    typeof api?.registerServer === "function" &&
    typeof api.unregisterServer === "function"
    ? api
    : undefined;
}
async function claudePath(): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    const path = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Thử vị trí kế tiếp nếu không có CLI ở đây. */
    }
  }
}

export function register(ctx: vscode.ExtensionContext): void {
  const provider = new HiveMcpProvider();
  ctx.subscriptions.push(provider);
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider === "function") {
    ctx.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider("xdev-hive.mcp", provider));
  }
  ctx.subscriptions.push(
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === "xdev-hive") provider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("xdevHive")) provider.refresh();
    }),
  );
  const files = new McpFiles(homedir());
  let pending = Promise.resolve();
  const run = (action: () => Promise<void>) => {
    pending = pending.then(action).catch(() => {
      void vscode.window.showErrorMessage(t("mcp.failed"));
    });
    return pending;
  };
  for (const tool of ["ClaudeCode", "Cursor", "Windsurf"] as const) {
    ctx.subscriptions.push(
      vscode.commands.registerCommand(`xdevHive.mcp.add${tool}`, () =>
        run(async () => {
          if (!vscode.workspace.isTrusted) {
            await vscode.window.showErrorMessage(t("mcp.untrusted"));
            return;
          }
          const label = tool === "ClaudeCode" ? "Claude Code" : tool;
          if (
            (await vscode.window.showInformationMessage(
              t("mcp.confirm", { tool: label }),
              { modal: true },
              t("mcp.accept"),
            )) !== t("mcp.accept")
          )
            return;
          const binary = await findBinary("hive", config.binPath());
          if (!binary) {
            await vscode.window.showErrorMessage(t("mcp.noBinary"));
            return;
          }
          const server = { command: binary.path, args: ["mcp"] };
          const api = tool === "Cursor" ? cursorApi() : undefined;
          let registered = false;
          if (api) {
            try {
              await api.registerServer({ name: "xdev-hive", server: { ...server, env: {} } });
              await ctx.globalState.update("mcp.cursorApi", true);
              registered = true;
            } catch {
              /* API riêng có thể đổi giữa các bản Cursor; dùng file khi API không hoạt động. */
            }
          }
          if (!registered) {
            const claude = tool === "ClaudeCode" ? await claudePath() : undefined;
            await files.add(
              tool,
              server,
              claude
                ? async () => {
                    const result = await exec(claude, [
                      "mcp",
                      "add",
                      "--scope",
                      "user",
                      "xdev-hive",
                      "--",
                      binary.path,
                      "mcp",
                    ]);
                    if (result.code !== 0) throw new Error(t("mcp.failed"));
                  }
                : undefined,
            );
          }
          await vscode.window.showInformationMessage(t("mcp.done", { tool: label }));
        }),
      ),
    );
  }
  ctx.subscriptions.push(
    vscode.commands.registerCommand("xdevHive.mcp.remove", () =>
      run(async () => {
        const selected = await vscode.window.showQuickPick(["Claude Code", "Cursor", "Windsurf"], {
          placeHolder: t("mcp.remove"),
        });
        if (
          !selected ||
          (await vscode.window.showInformationMessage(
            t("mcp.removeConfirm", { tool: selected }),
            { modal: true },
            t("mcp.removeAccept"),
          )) !== t("mcp.removeAccept")
        )
          return;
        const tool: Tool = selected === "Claude Code" ? "ClaudeCode" : (selected as Tool);
        if (tool === "Cursor" && ctx.globalState.get("mcp.cursorApi")) {
          const api = cursorApi();
          if (!api) throw new Error(t("mcp.failed"));
          await api.unregisterServer("xdev-hive");
          await ctx.globalState.update("mcp.cursorApi", undefined);
        }
        await files.remove(tool);
        await vscode.window.showInformationMessage(t("mcp.removed", { tool: selected }));
      }),
    ),
  );
}
