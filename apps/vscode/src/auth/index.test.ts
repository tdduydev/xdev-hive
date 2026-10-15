import { afterEach, describe, expect, it, vi } from "vitest";
import type * as VSCode from "vscode";
import * as vscode from "vscode";
import { auth, register } from "@/auth/index.ts";
import type { HiveAuthenticationProvider } from "@/auth/provider.ts";
import { TokenStore } from "@/auth/store.ts";
import { orgId, secrets, token } from "@/auth/test-support.ts";

const state = vi.hoisted(() => ({
  providers: [] as HiveAuthenticationProvider[],
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  hub: "https://hub.example",
}));
vi.mock("@/auth/hub-url.ts", () => ({ hubUrl: async () => state.hub, setHubUrl: vi.fn() }));
vi.mock("@/lib/exec.ts", () => ({ exec: vi.fn().mockRejectedValue(new Error("ENOENT")) }));
vi.mock("vscode", async (original) => {
  const base = await original<typeof VSCode>();
  return {
    ...base,
    authentication: {
      registerAuthenticationProvider: vi.fn((_id, _label, provider) => {
        state.providers.push(provider);
        return { dispose() {} };
      }),
      getSession: vi.fn(),
    },
    commands: {
      ...base.commands,
      registerCommand: vi.fn((name, fn) => {
        state.commands.set(name, fn);
        return { dispose() {} };
      }),
    },
    window: {
      ...base.window,
      state: { focused: true },
      onDidChangeWindowState: vi.fn(() => ({ dispose() {} })),
      showWarningMessage: vi.fn().mockResolvedValue("Chỉ VS Code"),
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
    },
  };
});

const subscriptions: VSCode.Disposable[] = [];
afterEach(() => {
  for (const item of subscriptions.splice(0)) item.dispose();
  state.providers.length = 0;
  state.commands.clear();
  vi.unstubAllGlobals();
});

describe("đăng ký provider và đồng bộ cửa sổ", () => {
  it("đăng ký Accounts, lệnh, context; SecretStorage báo thay đổi cho cả hai provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.endsWith("/me")
            ? { id: "dev", name: "Dev", email: "dev@example.com" }
            : { id: orgId, name: "Hive", role: "admin" },
        ),
      ),
    );
    const secret = secrets();
    const context = { subscriptions, secrets: secret } as unknown as VSCode.ExtensionContext;
    register(context);
    register(context);
    expect(vscode.authentication.registerAuthenticationProvider).toHaveBeenCalledWith(
      "xdev-hive",
      "xDev Hive",
      expect.anything(),
      { supportsMultipleAccounts: false },
    );
    expect(state.commands.has("xdevHive.signIn")).toBe(true);
    expect(state.commands.has("xdevHive.signOut")).toBe(true);
    expect(state.commands.has("xdevHive.setHubUrl")).toBe(true);
    await vi.waitFor(async () => {
      for (const provider of state.providers) expect(await provider.getSessions()).toEqual([]);
    });
    const changes = state.providers.map((provider) => {
      const fn = vi.fn();
      provider.onDidChangeSessions(fn);
      return fn;
    });
    const store = new TokenStore(secret, vi.fn().mockRejectedValue(new Error("ENOENT")), () => "missing");
    await store.write(state.hub, token);
    await vi.waitFor(() => {
      for (const fn of changes)
        expect(fn).toHaveBeenCalledWith(
          expect.objectContaining({ added: [expect.objectContaining({ accessToken: token })] }),
        );
    });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("setContext", "xdevHive.signedIn", true);
    const session = (await state.providers[0]?.getSessions())?.[0];
    await state.providers[0]?.removeSession(session?.id ?? "");
    await vi.waitFor(() => {
      for (const fn of changes) expect(fn.mock.calls.at(-1)?.[0].removed).toHaveLength(1);
    });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("setContext", "xdevHive.signedIn", false);
  });

  it("API token dùng silent mặc định, chỉ mở đăng nhập khi được yêu cầu", async () => {
    await auth.token();
    expect(vscode.authentication.getSession).toHaveBeenLastCalledWith("xdev-hive", [], { silent: true });
    await auth.token({ createIfNone: true });
    expect(vscode.authentication.getSession).toHaveBeenLastCalledWith("xdev-hive", [], { createIfNone: true });
  });
});
