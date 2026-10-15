import type * as vscode from "vscode";
import { register as registerBadge } from "@/views/badge.ts";
import { register as registerSdlc } from "@/views/sdlc.ts";

export function register(ctx: vscode.ExtensionContext): void {
  registerBadge(ctx);
  registerSdlc(ctx);
}
