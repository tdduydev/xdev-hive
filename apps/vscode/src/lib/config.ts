import * as vscode from "vscode";

const SECTION = "xdevHive";

// `hubUrl` và `binPath` có phạm vi machine nên workspace không ghi đè được; đọc qua `inspect` để chắc chắn bỏ
// giá trị workspace kể cả khi manifest bị sửa sau này.
function trusted(key: string): string {
  const info = vscode.workspace.getConfiguration(SECTION).inspect<string>(key);
  return (info?.globalValue ?? "").trim();
}

export const config = {
  hubUrl: () => trusted("hubUrl").replace(/\/+$/, ""),
  binPath: () => trusted("binPath"),
  workerAutoStart: () => vscode.workspace.getConfiguration(SECTION).get<boolean>("worker.autoStart", false),
  mcpTransport: () => vscode.workspace.getConfiguration(SECTION).get<"http" | "stdio">("mcp.transport", "http"),
  codeLensEnabled: () => vscode.workspace.getConfiguration(SECTION).get<boolean>("codeLens.enabled", true),
};
