import type * as vscode from "vscode";
import { register as registerArtifacts } from "@/views/artifacts.ts";
import { register as registerBadge } from "@/views/badge.ts";

export function register(ctx: vscode.ExtensionContext): void {
  registerBadge(ctx);
  registerArtifacts(ctx);
}
