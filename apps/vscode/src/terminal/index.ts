import * as vscode from "vscode";
import { config } from "@/lib/config.ts";
import { type LaunchSpec, TerminalProfiles } from "@/terminal/profiles.ts";
import { findBinary } from "@/worker/bin.ts";
import { ipc, workerAllowed } from "@/worker/index.ts";

function open(spec: LaunchSpec | undefined): void {
  if (!spec) return;
  vscode.window
    .createTerminal({ name: spec.name, shellPath: spec.shellPath, shellArgs: spec.shellArgs, cwd: spec.cwd })
    .show();
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
      return spec
        ? new vscode.TerminalProfile({
            name: spec.name,
            shellPath: spec.shellPath,
            shellArgs: spec.shellArgs,
            cwd: spec.cwd,
          })
        : undefined;
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
