import type * as vscode from "vscode";

export { createHubClient, type HubAuth, type HubClient, type HubOptions, orgFromToken } from "@/hub/client.ts";
export { errorMessage, HubError } from "@/hub/errors.ts";
export { type PollOptions, poll } from "@/hub/poll.ts";
export { workspaceProject } from "@/hub/project.ts";
export { type RunStreamEvent, type StreamOptions, streamRun } from "@/hub/sse.ts";

// Client được tạo khi view cần dữ liệu để activate không đợi mạng hay đăng nhập.
export function register(_ctx: vscode.ExtensionContext): void {}
