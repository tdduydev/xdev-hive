import { expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ profiles: [] as string[], commands: [] as string[] }));

vi.mock("vscode", async (original) => {
  const base = await original<typeof import("vscode")>();
  const disposable = { dispose() {} };
  return {
    ...base,
    TerminalProfile: class {},
    window: {
      ...base.window,
      registerTerminalProfileProvider: (id: string) => {
        registered.profiles.push(id);
        return disposable;
      },
    },
    commands: {
      ...base.commands,
      registerCommand: (id: string) => {
        registered.commands.push(id);
        return disposable;
      },
    },
  };
});

import { register } from "@/terminal/index.ts";
import { createContext } from "../../test/vscode-mock.ts";

it("đăng ký hai profile và hai lệnh khớp manifest", () => {
  const ctx = createContext();
  register(ctx as never);
  expect(registered.profiles).toEqual(["xdev-hive.leader", "xdev-hive.attach"]);
  expect(registered.commands).toEqual(["xdevHive.terminal.openLeader", "xdevHive.terminal.attach"]);
  expect(ctx.subscriptions).toHaveLength(4);
});
