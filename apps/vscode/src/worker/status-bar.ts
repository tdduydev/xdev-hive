import * as vscode from "vscode";
import { t } from "@/lib/i18n.ts";
import type { WorkerSupervisor } from "@/worker/supervisor.ts";
import "@/worker/strings.ts";

export function statusBar(supervisor: WorkerSupervisor): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  const update = () => {
    const state = supervisor.state;
    item.text = `$(${state === "Starting" || state === "Stopping" ? "sync~spin" : "server"}) Hive · ${t(`worker.${state}`)}`;
    item.tooltip = supervisor.status
      ? `${t(`worker.${state}`)} · ${supervisor.status.owner} · ${supervisor.status.runs}`
      : t(`worker.${state}`);
    item.command =
      state === "Owned"
        ? "xdevHive.worker.stop"
        : state === "Missing"
          ? "xdevHive.worker.install"
          : state === "External" || state === "Error"
            ? "xdevHive.showLog"
            : "xdevHive.worker.start";
    void vscode.commands.executeCommand(
      "setContext",
      "xdevHive.worker.owned",
      state === "Owned" || state === "Starting",
    );
    void vscode.commands.executeCommand("setContext", "xdevHive.hasBinary", Boolean(supervisor.binary));
    item.show();
  };
  supervisor.on("change", update);
  update();
  return new vscode.Disposable(() => {
    supervisor.off("change", update);
    item.dispose();
  });
}
