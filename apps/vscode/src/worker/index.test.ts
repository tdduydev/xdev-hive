import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  item: { text: "", tooltip: "", command: "", show: vi.fn(), dispose: vi.fn() },
  options: undefined as unknown,
  current: undefined as unknown,
}));
vi.mock("vscode", async (original) => {
  const api = await original<typeof import("vscode")>();
  return {
    ...api,
    UIKind: { Desktop: 1, Web: 2 },
    StatusBarAlignment: { Left: 1 },
    env: { remoteName: undefined, uiKind: 1 },
    window: { ...api.window, createStatusBarItem: vi.fn(() => mocks.item) },
  };
});
vi.mock("@/worker/supervisor.ts", async (original) => {
  const api = await original<typeof import("@/worker/supervisor.ts")>();
  return {
    ...api,
    WorkerSupervisor: class extends api.WorkerSupervisor {
      constructor(options: ConstructorParameters<typeof api.WorkerSupervisor>[0]) {
        super(options);
        mocks.options = options;
        mocks.current = this;
      }
      override watch() {}
    },
  };
});

import * as vscode from "vscode";
import { register, workerAllowed } from "@/worker/index.ts";
import { statusBar } from "@/worker/status-bar.ts";
import { type SupervisorOptions, WorkerSupervisor } from "@/worker/supervisor.ts";

afterEach(() => {
  Object.assign(vscode.env, { remoteName: undefined, uiKind: 1 });
  Object.assign(vscode.workspace, { isTrusted: true });
  vi.clearAllMocks();
});

it("chỉ cho worker chạy ở local, SSH hoặc WSL và workspace tin cậy", () => {
  for (const remoteName of [undefined, "ssh-remote", "wsl"]) {
    Object.assign(vscode.env, { remoteName });
    expect(workerAllowed()).toBe(true);
  }
  for (const remoteName of ["dev-container", "codespaces", "tunnel"]) {
    Object.assign(vscode.env, { remoteName });
    expect(workerAllowed()).toBe(false);
  }
  Object.assign(vscode.env, { remoteName: undefined, uiKind: 2 });
  expect(workerAllowed()).toBe(false);
  Object.assign(vscode.env, { uiKind: 1 });
  Object.assign(vscode.workspace, { isTrusted: false });
  expect(workerAllowed()).toBe(false);
});

it("đăng ký đủ ba lệnh và huỷ supervisor qua subscription", async () => {
  const ctx = { subscriptions: [] as vscode.Disposable[] };
  register(ctx as vscode.ExtensionContext);
  const registered = vi.mocked(vscode.commands.registerCommand).mock.calls.map(([id]) => id);
  expect(registered).toEqual(["xdevHive.worker.start", "xdevHive.worker.stop", "xdevHive.worker.install"]);
  const options = mocks.options as SupervisorOptions;
  expect(options.autoStart()).toBe(false);
  const dispose = vi.spyOn(mocks.current as WorkerSupervisor, "dispose");
  for (const subscription of ctx.subscriptions) subscription.dispose();
  expect(dispose).toHaveBeenCalled();
});

it("status bar phản ánh Owned/External và context, hủy listener khi đóng", () => {
  const supervisor = new WorkerSupervisor({} as SupervisorOptions);
  const bar = statusBar(supervisor);
  supervisor.binary = { path: "/worker", version: "0.2.16" };
  supervisor.state = "Owned";
  supervisor.emit("change");
  expect(mocks.item.command).toBe("xdevHive.worker.stop");
  expect(vscode.commands.executeCommand).toHaveBeenCalledWith("setContext", "xdevHive.worker.owned", true);
  supervisor.state = "External";
  supervisor.emit("change");
  expect(mocks.item.command).toBe("xdevHive.showLog");
  expect(mocks.item.text).toContain("Worker dùng chung");
  bar.dispose();
  expect(supervisor.listenerCount("change")).toBe(0);
});
