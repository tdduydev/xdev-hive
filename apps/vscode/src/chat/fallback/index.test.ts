import { contract } from "@xdev-hive/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as VSCode from "vscode";
import { register } from "@/chat/fallback/index.ts";
import { ALLOWED_PROCEDURES } from "@/webview-host/allowlist/index.ts";

const state = vi.hoisted(() => ({
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  disposers: [] as (() => void)[],
  reveal: vi.fn(),
  createPanel: vi.fn(),
}));
vi.mock("@/webview-host/index.ts", () => ({ createPanel: state.createPanel }));
vi.mock("vscode", async (original) => {
  const base = await original<typeof VSCode>();
  return {
    ...base,
    commands: {
      ...base.commands,
      registerCommand: vi.fn((name, fn) => {
        state.commands.set(name, fn);
        return { dispose() {} };
      }),
    },
  };
});

function ctx() {
  return { subscriptions: [] as { dispose(): void }[] } as unknown as VSCode.ExtensionContext;
}

afterEach(() => {
  state.commands.clear();
  state.disposers.length = 0;
  vi.clearAllMocks();
});

describe("chat dự phòng", () => {
  it("lệnh openChat mở panel chat và đưa tab đang mở lên khi bấm lại", () => {
    state.createPanel.mockImplementation(() => ({
      reveal: state.reveal,
      onDidDispose: (fn: () => void) => state.disposers.push(fn),
    }));
    register(ctx());
    const open = state.commands.get("xdevHive.openChat");
    expect(open).toBeTypeOf("function");

    open?.();
    expect(state.createPanel).toHaveBeenCalledWith(expect.anything(), "chat");
    open?.();
    expect(state.createPanel).toHaveBeenCalledTimes(1);
    expect(state.reveal).toHaveBeenCalledTimes(1);

    // Đóng tab thì lần sau mở panel mới, không reveal panel đã huỷ.
    for (const dispose of state.disposers) dispose();
    open?.();
    expect(state.createPanel).toHaveBeenCalledTimes(2);
  });

  it("allowlist chỉ gồm thủ tục có thật trong hợp đồng và không có ghi ngoài phạm vi chat", () => {
    for (const path of ALLOWED_PROCEDURES.chat) {
      const parts = path.replace(/^\/rpc\//, "").split("/");
      let node: unknown = contract;
      for (const part of parts) node = (node as Record<string, unknown> | undefined)?.[part];
      expect(node, path).toBeDefined();
    }
    expect([...ALLOWED_PROCEDURES.chat].sort()).toEqual(
      [
        "/rpc/leader/approvals/approve",
        "/rpc/leader/approvals/list",
        "/rpc/leader/approvals/reject",
        "/rpc/leader/threads/create",
        "/rpc/leader/threads/get",
        "/rpc/leader/threads/list",
        "/rpc/leader/threads/send",
        "/rpc/projects/list",
        "/rpc/runs/start",
        "/rpc/tasks/create",
      ].sort(),
    );
  });
});
