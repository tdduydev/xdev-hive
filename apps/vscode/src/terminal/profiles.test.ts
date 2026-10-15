import { beforeEach, describe, expect, it, vi } from "vitest";

const ui = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showQuickPick: vi.fn(),
  executeCommand: vi.fn(),
}));

// Mock chung chưa có các API terminal; bổ sung tại đây để không đụng file dùng chung.
vi.mock("vscode", async (original) => {
  const base = await original<typeof import("vscode")>();
  return {
    ...base,
    window: { ...base.window, ...ui },
    commands: { ...base.commands, executeCommand: ui.executeCommand },
    workspace: { ...base.workspace, workspaceFolders: [{ uri: { scheme: "file", fsPath: "/work/app" } }] },
  };
});

import { attachArgs, parseSessions, type TerminalDeps, TerminalProfiles } from "@/terminal/profiles.ts";

const hive = { path: "/bin/hive", version: "0.2.16" };

function make(over: Partial<TerminalDeps> = {}) {
  return new TerminalProfiles({
    find: async () => hive,
    sessions: async () => ({ sessions: [] }),
    allowed: () => true,
    installCommand: "xdevHive.worker.install",
    ...over,
  });
}

beforeEach(() => vi.clearAllMocks());

describe("Hive Leader", () => {
  it("chạy `hive chat` trong thư mục workspace", async () => {
    expect(await make().leader()).toEqual({
      name: "Hive Leader",
      shellPath: "/bin/hive",
      shellArgs: ["chat"],
      cwd: "/work/app",
    });
  });

  it("không có hive thì báo đúng chữ và không mở terminal", async () => {
    ui.showErrorMessage.mockResolvedValue(undefined);
    expect(await make({ find: async () => undefined }).leader()).toBeUndefined();
    expect(ui.showErrorMessage).toHaveBeenCalledWith("Cần cài hive CLI", "Cài worker");
  });

  it("chọn 'Cài worker' thì chạy lệnh cài", async () => {
    ui.showErrorMessage.mockResolvedValue("Cài worker");
    await make({ find: async () => undefined }).leader();
    expect(ui.executeCommand).toHaveBeenCalledWith("xdevHive.worker.install");
  });

  it("Restricted Mode không tìm và không chạy hive", async () => {
    const find = vi.fn();
    expect(await make({ allowed: () => false, find }).leader()).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
    expect(ui.showWarningMessage).toHaveBeenCalled();
  });
});

describe("Hive: gắn vào phiên", () => {
  const sessions = async () => ({
    sessions: [
      { id: "ab12", cli: "claude", cwd: "/work/app", started: "2026-10-15T01:02:03Z", controlled: true, viewers: 2 },
    ],
  });

  it("chọn điều khiển thì chạy `hive attach <id>`", async () => {
    ui.showQuickPick
      .mockImplementationOnce(async (items) => items[0])
      .mockImplementationOnce(async (items) => items[0]);
    expect(await make({ sessions }).attach()).toMatchObject({
      name: "Hive · ab12",
      shellPath: "/bin/hive",
      shellArgs: ["attach", "ab12"],
    });
  });

  it("chọn 'Chỉ xem' thì thêm --view", async () => {
    ui.showQuickPick
      .mockImplementationOnce(async (items) => items[0])
      .mockImplementationOnce(async (items: { label: string }[]) => items.find((i) => i.label === "Chỉ xem"));
    expect((await make({ sessions }).attach())?.shellArgs).toEqual(["attach", "ab12", "--view"]);
  });

  it("huỷ ở bước nào cũng không mở terminal", async () => {
    ui.showQuickPick.mockResolvedValueOnce(undefined);
    expect(await make({ sessions }).attach()).toBeUndefined();
    ui.showQuickPick.mockImplementationOnce(async (items) => items[0]).mockResolvedValueOnce(undefined);
    expect(await make({ sessions }).attach()).toBeUndefined();
  });

  it("không có hive thì báo đúng chữ, không hỏi worker", async () => {
    ui.showErrorMessage.mockResolvedValue(undefined);
    const list = vi.fn();
    expect(await make({ find: async () => undefined, sessions: list }).attach()).toBeUndefined();
    expect(ui.showErrorMessage).toHaveBeenCalledWith("Cần cài hive CLI", "Cài worker");
    expect(list).not.toHaveBeenCalled();
  });

  it("không có phiên hoặc worker lỗi thì báo, không hiện menu", async () => {
    expect(await make().attach()).toBeUndefined();
    expect(ui.showInformationMessage).toHaveBeenCalledWith("Không có phiên nào đang chạy trên máy này.");
    expect(
      await make({
        sessions: async () => {
          throw new Error("Worker không trả lời đúng hạn");
        },
      }).attach(),
    ).toBeUndefined();
    expect(ui.showErrorMessage).toHaveBeenCalledWith("Không đọc được danh sách phiên: Worker không trả lời đúng hạn");
    expect(ui.showQuickPick).not.toHaveBeenCalled();
  });
});

describe("parseSessions", () => {
  it("bỏ dòng hỏng và mã phiên có thể thành cờ", () => {
    const list = parseSessions([null, "x", { id: 5 }, { id: "--view" }, { id: "a b" }, { id: "ok-1.2", viewers: "3" }]);
    expect(list).toEqual([{ id: "ok-1.2", cli: "", cwd: "", started: undefined, controlled: false, viewers: 0 }]);
  });

  it("attachArgs", () => {
    expect(attachArgs("x", false)).toEqual(["attach", "x"]);
    expect(attachArgs("x", true)).toEqual(["attach", "x", "--view"]);
  });
});
