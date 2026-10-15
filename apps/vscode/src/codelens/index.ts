import * as vscode from "vscode";
import { auth } from "@/auth/index.ts";
import { registerCommands } from "@/codelens/commands.ts";
import { Hovers } from "@/codelens/hover.ts";
import { HubStatus } from "@/codelens/hub-status.ts";
import { MemoryTokens } from "@/codelens/memory-tokens.ts";
import { ScopeIndex } from "@/codelens/scope-index.ts";
import { SymbolLensProvider } from "@/codelens/symbols.ts";
import { TasksLensProvider } from "@/codelens/tasks-lens.ts";
import { createHubClient, errorMessage, poll, workspaceProject } from "@/hub/index.ts";
import { config } from "@/lib/config.ts";
import { exec } from "@/lib/exec.ts";
import { log } from "@/lib/log.ts";
import { findBinary } from "@/worker/bin.ts";
import { workerAllowed } from "@/worker/index.ts";

const TASKS_GLOB = "**/specs/*/tasks.md";
const STATUS_INTERVAL_MS = 30_000;
const PROJECT_TTL_MS = 5 * 60_000;

export function register(ctx: vscode.ExtensionContext): void {
  const trusted = () => vscode.workspace.isTrusted;
  const hub = createHubClient({ hubUrl: config.hubUrl, auth });
  const projects = new Map<string, { at: number; id: string | undefined }>();

  async function workerPath(): Promise<string | undefined> {
    if (!trusted() || !workerAllowed()) return undefined;
    return (await findBinary("hive-worker", config.binPath()))?.path;
  }

  const status = new HubStatus({
    signedIn: async () => Boolean(await auth.token()),
    project: async (root) => {
      const cached = projects.get(root);
      if (cached && Date.now() - cached.at < PROJECT_TTL_MS) return cached.id;
      const worker = await workerPath();
      const id = await workspaceProject(root, {
        ...(worker ? { workerPath: worker } : {}),
        trusted: trusted(),
        hubUrl: config.hubUrl(),
      });
      projects.set(root, { at: Date.now(), id });
      return id;
    },
    tasks: (projectId, signal) => hub.rpc.tasks.list({ projectId }, { signal }),
    runs: (projectId, signal) => hub.rpc.runs.latest({ projectId }, { signal }),
  });

  const uris = new Map<string, vscode.Uri>();
  const index = new ScopeIndex({
    files: async () => {
      const found = await vscode.workspace.findFiles(TASKS_GLOB, "**/node_modules/**");
      uris.clear();
      for (const uri of found) uris.set(uri.fsPath, uri);
      return [...uris.keys()];
    },
    read: async (fsPath) =>
      new TextDecoder().decode(await vscode.workspace.fs.readFile(uris.get(fsPath) ?? vscode.Uri.file(fsPath))),
  });

  const tokens = new MemoryTokens({
    scan: async () => {
      const path = await workerPath();
      if (!path) return undefined;
      const result = await exec(path, ["memory", "scan", "--json"], { timeoutMs: 15_000 });
      return result.code === 0 ? JSON.parse(result.stdout) : undefined;
    },
  });

  let polling: vscode.Disposable | undefined;
  const reportError = (error: unknown) => log(`CodeLens không hỏi được hub: ${errorMessage(error)}`);
  const tasksLens = new TasksLensProvider({
    enabled: config.codeLensEnabled,
    trusted,
    status,
    watch: (root, spec) => {
      const isNew = status.watchRoot(root, spec);
      if (!polling) {
        polling = poll((signal) => status.refresh(signal), {
          intervalMs: STATUS_INTERVAL_MS,
          focused: () => vscode.window.state.focused,
          onDidChangeWindowState: vscode.window.onDidChangeWindowState,
          onError: reportError,
        });
        ctx.subscriptions.push(polling);
      } else if (isNew) {
        status.refresh(new AbortController().signal).catch(reportError);
      }
    },
  });
  const symbolsLens = new SymbolLensProvider({
    enabled: config.codeLensEnabled,
    trusted,
    symbols: (uri) => vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri),
  });
  const refreshLenses = () => {
    tasksLens.refresh();
    symbolsLens.refresh();
  };
  const rebuildIndex = () => {
    if (config.codeLensEnabled())
      index.rebuild().catch((error) => log(`Không dựng được chỉ mục PHẠM VI: ${String(error)}`));
  };

  const watcher = vscode.workspace.createFileSystemWatcher(TASKS_GLOB);
  ctx.subscriptions.push(
    registerLens(tasksLens, { pattern: TASKS_GLOB }),
    registerLens(symbolsLens, { scheme: "file" }),
    vscode.languages.registerHoverProvider(
      { scheme: "file" },
      new Hovers({ enabled: config.codeLensEnabled, index, tokens }),
    ),
    status.onDidChange(refreshLenses),
    watcher,
    watcher.onDidCreate((uri) => void index.update(uri.fsPath).then(() => uris.set(uri.fsPath, uri))),
    watcher.onDidChange((uri) => void index.update(uri.fsPath)),
    watcher.onDidDelete((uri) => void index.update(uri.fsPath)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("xdevHive.codeLens")) return;
      rebuildIndex();
      refreshLenses();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(refreshLenses),
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id !== "xdev-hive") return;
      status.refresh(new AbortController().signal).catch(reportError);
    }),
  );
  registerCommands(ctx);
  rebuildIndex();
}

function registerLens(provider: vscode.CodeLensProvider, selector: vscode.DocumentSelector): vscode.Disposable {
  return vscode.languages.registerCodeLensProvider(selector, provider);
}
