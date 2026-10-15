import * as vscode from "vscode";
import { setHubUrl } from "@/auth/hub-url.ts";
import { HiveAuthenticationProvider } from "@/auth/provider.ts";
import { TokenStore } from "@/auth/store.ts";
import { t } from "@/lib/i18n.ts";
import "@/auth/strings.ts";

export { HiveAuthenticationProvider, type HiveSession } from "@/auth/provider.ts";

let provider: HiveAuthenticationProvider | undefined;
export const auth = {
  async token(options: { createIfNone?: boolean } = {}): Promise<string | undefined> {
    const session = await vscode.authentication.getSession(
      "xdev-hive",
      [],
      options.createIfNone ? { createIfNone: true } : { silent: true },
    );
    return session?.accessToken;
  },
  invalidate: () => provider?.invalidate(),
};

export function register(ctx: vscode.ExtensionContext): void {
  const current = new HiveAuthenticationProvider(new TokenStore(ctx.secrets));
  provider = current;
  const report = (error: unknown) => {
    // Lỗi bên ngoài có thể chứa token hoặc thân phản hồi từ hub.
    const known = [
      "auth.noHub",
      "auth.badUrl",
      "auth.health",
      "auth.timeout",
      "auth.cancelled",
      "auth.remote",
      "auth.storage",
      "auth.expired",
      "auth.network",
    ];
    const message =
      error instanceof Error && known.some((key) => t(key) === error.message) ? error.message : t("auth.failed");
    void vscode.window.showErrorMessage(message);
  };
  const refresh = () => {
    void current.getSessions().catch(report);
  };
  const timer = setInterval(() => {
    if (vscode.window.state.focused) refresh();
  }, 60_000);
  timer.unref();
  ctx.subscriptions.push(
    current,
    vscode.authentication.registerAuthenticationProvider("xdev-hive", "xDev Hive", current, {
      supportsMultipleAccounts: false,
    }),
    current.onDidChangeSessions((event) => {
      void vscode.commands.executeCommand(
        "setContext",
        "xdevHive.signedIn",
        (event.added?.length ?? 0) > 0 || (event.changed?.length ?? 0) > 0,
      );
    }),
    ctx.secrets.onDidChange(() => refresh()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("xdevHive.hubUrl")) void current.reload().catch(report);
    }),
    vscode.commands.registerCommand("xdevHive.signIn", async () => {
      try {
        await vscode.authentication.getSession("xdev-hive", [], { createIfNone: true });
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand("xdevHive.signOut", async () => {
      try {
        for (const session of await current.getSessions()) await current.removeSession(session.id);
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand("xdevHive.setHubUrl", async () => {
      try {
        await setHubUrl();
        await current.getSessions();
      } catch (error) {
        report(error);
      }
    }),
    new vscode.Disposable(() => {
      clearInterval(timer);
      if (provider === current) provider = undefined;
    }),
  );
  void vscode.commands.executeCommand("setContext", "xdevHive.signedIn", false);
  refresh();
}
