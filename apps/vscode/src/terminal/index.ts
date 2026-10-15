import * as vscode from "vscode";
import { config } from "@/lib/config.ts";
import { type LaunchSpec, TerminalProfiles } from "@/terminal/profiles.ts";
import { findBinary } from "@/worker/bin.ts";
import { ipc, workerAllowed } from "@/worker/index.ts";

// Chỉ đặt `cwd` khi có: workspace ảo hoặc không mở thư mục thì để VS Code tự chọn.
function options(spec: LaunchSpec) {
  return {
    name: spec.name,
    shellPath: spec.shellPath,
    shellArgs: spec.shellArgs,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
  };
}

function open(spec: LaunchSpec | undefined): void {
  if (!spec) return;
  vscode.window.createTerminal(options(spec)).show();
}

export function register(ctx: vscode.ExtensionContext): void {
  const profiles = new TerminalProfiles({
    find: () => findBinary("hive", config.binPath()),
    sessions: () => ipc.sessions(),
    allowed: workerAllowed,
    installCommand: "xdevHive.worker.install",
  });
  const provider = (build: () => Promise<LaunchSpec | undefined>): vscode.TerminalProfileProvider => ({
    provideTerminalProfile: async () => {
      const spec = await build();
      return spec ? new vscode.TerminalProfile(options(spec)) : undefined;
    },
  });
  ctx.subscriptions.push(
    vscode.window.registerTerminalProfileProvider(
      "xdev-hive.leader",
      provider(() => profiles.leader()),
    ),
    vscode.window.registerTerminalProfileProvider(
      "xdev-hive.attach",
      provider(() => profiles.attach()),
    ),
    vscode.commands.registerCommand("xdevHive.terminal.openLeader", async () => open(await profiles.leader())),
    vscode.commands.registerCommand("xdevHive.terminal.attach", async () => open(await profiles.attach())),
  );
}
