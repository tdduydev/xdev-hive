import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { config } from "@/lib/config.ts";
import { t } from "@/lib/i18n.ts";
import { log } from "@/lib/log.ts";
import { redact } from "@/lib/redact.ts";
import { findBinary, installBinaries } from "@/worker/bin.ts";
import { configDirectory, WorkerIpc } from "@/worker/ipc.ts";
import { statusBar } from "@/worker/status-bar.ts";
import { WorkerSupervisor } from "@/worker/supervisor.ts";

export const ipc = new WorkerIpc();
export let supervisor: WorkerSupervisor | undefined;

export function workerAllowed(): boolean {
  return (
    vscode.workspace.isTrusted &&
    vscode.env.uiKind !== vscode.UIKind.Web &&
    (!vscode.env.remoteName || ["ssh-remote", "wsl"].includes(vscode.env.remoteName))
  );
}

export function register(ctx: vscode.ExtensionContext): void {
  const current = new WorkerSupervisor({
    find: () => findBinary("hive-worker", config.binPath()),
    status: () => ipc.status(),
    registered: async () => {
      try {
        const path = process.env.HIVE_WORKER_CONFIG ?? join(configDirectory(), "xdev-hive", "worker.json");
        const cfg = JSON.parse(await readFile(path, "utf8"));
        return Boolean(cfg.machineId && cfg.machineToken);
      } catch {
        return false;
      }
    },
    autoStart: config.workerAutoStart,
    allowed: workerAllowed,
  });
  supervisor = current;
  ctx.subscriptions.push(
    new vscode.Disposable(() => {
      void current.dispose();
    }),
    statusBar(current),
  );
  const command = (id: string, action: () => Promise<unknown>) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await action();
        } catch (error) {
          log(String(error));
          void vscode.window.showErrorMessage(
            `Không thực hiện được lệnh worker: ${redact(error instanceof Error ? error.message : String(error))}`,
          );
        }
      }),
    );
  command("xdevHive.worker.start", async () => {
    if (!workerAllowed()) {
      void vscode.window.showInformationMessage(t("worker.unavailable"));
      return;
    }
    await current.start();
  });
  command("xdevHive.worker.stop", () => current.stop());
  command("xdevHive.worker.install", async () => {
    if (!workerAllowed()) {
      void vscode.window.showInformationMessage(t("worker.unavailable"));
      return;
    }
    const version = await installBinaries();
    void vscode.window.showInformationMessage(t("worker.install", { version }));
    await current.probe();
  });
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("xdevHive")) void current.probe();
    }),
  );
  if (workerAllowed()) current.watch();
}
