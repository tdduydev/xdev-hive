import * as vscode from "vscode";
import { t } from "@/lib/i18n.ts";
import { log } from "@/lib/log.ts";
import { redact } from "@/lib/redact.ts";
import { buildContextPack } from "@/local/context-pack.ts";
import { DOC_SCHEME, DocumentStore, PACK_DOC, reportDoc } from "@/local/document.ts";
import { memoryScan } from "@/local/memory.ts";
import { formatReport, type OptimizeProfile, optimizeReport, optimizeSet, optimizeStatus } from "@/local/optimize.ts";
import { LocalError } from "@/local/worker.ts";
import { type MachineNode, MachineTree } from "@/views/machine.ts";
import { supervisor } from "@/worker/index.ts";
import "@/local/strings.ts";
import "@/worker/strings.ts";

function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

function workerInfo() {
  if (!supervisor) return undefined;
  const { state, status } = supervisor;
  return {
    text: t(`worker.${state}`),
    ...(status ? { description: `${status.owner} · ${status.runs}` } : {}),
    missing: state === "Missing",
  };
}

async function pickFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) return folders[0]?.uri.fsPath;
  const picked = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath })),
    { placeHolder: t("pack.folder") },
  );
  return picked?.description;
}

/** Lệnh gọi từ nút trên dòng gói truyền node; từ Command Palette thì hỏi gói. */
async function pickProfile(node: MachineNode | undefined, want?: (p: OptimizeProfile) => boolean) {
  if (node?.type === "profile") return node.profile.id;
  const profiles = (await optimizeStatus()).filter((p) => p.supported && (want?.(p) ?? true));
  const picked = await vscode.window.showQuickPick(
    profiles.map((p) => ({ label: p.label || p.id, description: p.id })),
    { placeHolder: t("optimize.pick") },
  );
  return picked?.description;
}

export function register(ctx: vscode.ExtensionContext): void {
  const docs = new DocumentStore();
  const tree = new MachineTree({ workspaces: workspacePaths, worker: workerInfo });
  const open = async (uri: vscode.Uri) => {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  };
  const command = <A extends unknown[]>(id: string, action: (...args: A) => Promise<unknown>) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: A) => {
        try {
          await action(...args);
        } catch (error) {
          const text = redact(error instanceof Error ? error.message : String(error));
          log(`${id}: ${text}`);
          // LocalError đã là câu hoàn chỉnh cho người dùng; lỗi lạ thì chỉ hiện sau khi che bí mật.
          void vscode.window.showErrorMessage(
            error instanceof LocalError ? text : t("local.failed", { message: text }),
          );
        }
      }),
    );

  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DOC_SCHEME, docs),
    vscode.window.registerTreeDataProvider("xdev-hive.machine", tree),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("xdevHive")) tree.refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh("memory")),
  );
  supervisor?.on("change", () => tree.refresh());

  const toggle = (enable: boolean) => async (node?: MachineNode) => {
    const profile = await pickProfile(node, (p) => p.enabled !== enable);
    if (!profile) return;
    await optimizeSet(profile, enable);
    void vscode.window.showInformationMessage(t(enable ? "optimize.enabled" : "optimize.disabled", { profile }));
    tree.refresh("optimize");
  };
  command("xdevHive.local.optimize.enable", toggle(true));
  command("xdevHive.local.optimize.disable", toggle(false));
  command("xdevHive.local.optimize.report", async (node?: MachineNode) => {
    const profile = await pickProfile(node);
    if (!profile) return;
    await open(docs.set(reportDoc(profile), formatReport(profile, await optimizeReport(profile))));
  });
  command("xdevHive.local.memory.scan", async () => {
    tree.refresh("memory");
    const inv = await memoryScan();
    void vscode.window.showInformationMessage(t("memory.scanned", { files: (inv.files ?? []).length }));
  });
  command("xdevHive.local.contextPack.build", async () => {
    const cwd = await pickFolder();
    if (!cwd) {
      void vscode.window.showInformationMessage(t("local.noWorkspace"));
      return;
    }
    const query = await vscode.window.showInputBox({ prompt: t("pack.query"), placeHolder: t("pack.queryHint") });
    if (!query?.trim()) return;
    const pack = await buildContextPack(cwd, query.trim());
    tree.setPack(pack);
    await open(docs.set(PACK_DOC, pack.markdown));
    const choice = await vscode.window.showInformationMessage(
      t("pack.built", { files: pack.files.length, tokens: pack.tokens }),
      t("pack.copy"),
    );
    if (choice === t("pack.copy")) await vscode.commands.executeCommand("xdevHive.local.contextPack.copy");
  });
  command("xdevHive.local.contextPack.copy", async () => {
    const pack = tree.pack();
    if (!pack) {
      void vscode.window.showInformationMessage(t("pack.none"));
      return;
    }
    await vscode.env.clipboard.writeText(pack.markdown);
    void vscode.window.showInformationMessage(t("pack.copied"));
  });
}
