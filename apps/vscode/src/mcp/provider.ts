import * as vscode from "vscode";
import { auth } from "@/auth/index.ts";
import { workspaceProject } from "@/hub/index.ts";
import { config } from "@/lib/config.ts";
import { t } from "@/lib/i18n.ts";
import { findBinary } from "@/worker/bin.ts";
import "@/mcp/strings.ts";

export class HiveMcpProvider implements vscode.McpServerDefinitionProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this.changed.event;
  refresh(): void {
    this.changed.fire();
  }
  dispose(): void {
    this.changed.dispose();
  }

  async provideMcpServerDefinitions(): Promise<vscode.McpServerDefinition[]> {
    const hub = config.hubUrl();
    if (!hub || !(await auth.token())) return [];
    let url: URL;
    try {
      url = new URL(hub);
    } catch {
      return [];
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return [];
    if (config.mcpTransport() === "stdio") {
      if (!vscode.workspace.isTrusted) return [];
      const binary = await findBinary("hive", config.binPath());
      if (!binary) throw new Error(t("mcp.noBinary"));
      return [new vscode.McpStdioServerDefinition("xDev Hive", binary.path, ["mcp", "--hub", hub])];
    }
    return [new vscode.McpHttpServerDefinition("xDev Hive", vscode.Uri.parse(`${hub}/mcp`))];
  }

  async resolveMcpServerDefinition(
    definition: vscode.McpServerDefinition,
  ): Promise<vscode.McpServerDefinition | undefined> {
    const hub = config.hubUrl();
    const available = await this.provideMcpServerDefinitions();
    const current = available[0];
    if (!current) return;
    if (current instanceof vscode.McpStdioServerDefinition) return current;
    if (!(definition instanceof vscode.McpHttpServerDefinition) || definition.uri.toString() !== current.uri.toString())
      return;
    const token = await auth.token();
    if (!token || config.hubUrl() !== hub) return;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const project = cwd ? await workspaceProject(cwd, { hubUrl: config.hubUrl() }) : undefined;
    // Không sửa definition đã phát: token chỉ sống trong bản được resolve ngay trước khi kết nối.
    return new vscode.McpHttpServerDefinition("xDev Hive", current.uri, {
      Authorization: `Bearer ${token}`,
      ...(project ? { "X-Hive-Project": project } : {}),
    });
  }
}
