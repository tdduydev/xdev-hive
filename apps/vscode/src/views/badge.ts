import * as vscode from "vscode";
import { hubUrl } from "@/auth/hub-url.ts";
import { auth } from "@/auth/index.ts";
import { createHubClient, errorMessage, poll } from "@/hub/index.ts";
import { t } from "@/lib/i18n.ts";
import { ApprovalsTree } from "@/views/approvals.ts";
import { MergeQueueTree } from "@/views/merge-queue.ts";
import { type Command, type Connection, MineTree, type Node } from "@/views/mine.ts";
import { RunsTree } from "@/views/runs.ts";

export function register(ctx: vscode.ExtensionContext): void {
  const mine = new MineTree();
  const approvals = new ApprovalsTree();
  const runs = new RunsTree();
  const queue = new MergeQueueTree();
  const trees = [mine, approvals, runs, queue];
  let active = new AbortController();
  let disposed = false;

  const reset = (message?: string) => {
    active.abort();
    active = new AbortController();
    for (const tree of trees) tree.reset(message);
  };
  const connect = async (signal: AbortSignal): Promise<Connection | undefined> => {
    const url = await hubUrl();
    if (signal.aborted || disposed) return;
    if (!url) {
      for (const tree of trees) tree.reset(t("tree.noHub"));
      return;
    }
    const session = await vscode.authentication.getSession("xdev-hive", [], { silent: true });
    if (signal.aborted || disposed) return;
    if (!session) {
      for (const tree of trees) tree.reset(t("tree.signIn"));
      return;
    }
    const client = createHubClient({
      hubUrl: () => url,
      auth: {
        token: async () => (signal.aborted ? undefined : session.accessToken),
        invalidate: () => auth.invalidate(),
      },
    });
    return { hubUrl: url, session, client, signal };
  };
  const refresh = async (pollSignal?: AbortSignal) => {
    if (disposed || !vscode.window.state.focused) return;
    active.abort();
    active = new AbortController();
    const signal = pollSignal ? AbortSignal.any([active.signal, pollSignal]) : active.signal;
    let connection: Connection | undefined;
    try {
      connection = await connect(signal);
    } catch (error) {
      if (!signal.aborted) for (const tree of trees) tree.reset(errorMessage(error));
      throw error;
    }
    if (!connection) return;
    const current = connection;
    const results = await Promise.allSettled(trees.map((tree) => tree.refresh(current)));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  const safelyRefresh = () => refresh().catch(() => {});
  const command: Command = (name, action) => {
    ctx.subscriptions.push(
      vscode.commands.registerCommand(name, async (node?: Node) => {
        if (!node || disposed) return;
        const signal = active.signal;
        try {
          const connection = await connect(signal);
          if (!connection) return;
          await action(node, connection);
          if (!signal.aborted && /\.(rerun|cancel|approve|reject|remove)$/.test(name)) await safelyRefresh();
        } catch (error) {
          if (!signal.aborted) void vscode.window.showErrorMessage(errorMessage(error));
        }
      }),
    );
  };
  for (const tree of trees) tree.commands(command);
  ctx.subscriptions.push(
    ...trees,
    vscode.commands.registerCommand("xdevHive.refresh", safelyRefresh),
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id !== "xdev-hive") return;
      reset();
      void safelyRefresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("xdevHive.hubUrl") && !event.affectsConfiguration("xdevHive.language")) return;
      reset();
      void safelyRefresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      reset();
      void safelyRefresh();
    }),
    new vscode.Disposable(() => {
      disposed = true;
      active.abort();
      runs.stop();
    }),
    poll(refresh, {
      intervalMs: 60_000,
      focused: () => vscode.window.state.focused,
      onDidChangeWindowState: vscode.window.onDidChangeWindowState,
    }),
  );
}
