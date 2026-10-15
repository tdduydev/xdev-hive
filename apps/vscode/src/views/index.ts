import type * as vscode from "vscode";
import { register as registerArtifacts } from "@/views/artifacts.ts";

// Task của phần này điền thân hàm; extension.ts đã gọi sẵn.
export function register(ctx: vscode.ExtensionContext): void {
  registerArtifacts(ctx);
}
