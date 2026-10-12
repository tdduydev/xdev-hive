import { afterEach, describe, expect, it } from "vitest";
import { hub } from "@/lib/hub-rpc.ts";

type Call = { command: string; args?: Record<string, unknown> | undefined };

function fakeTauri(reply: (args: Record<string, unknown>) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const r = reply(args ?? {});
        return { status: r.status, contentType: "application/json", body: JSON.stringify(r.body) } as T;
      },
    },
  };
  return calls;
}

afterEach(() => {
  delete window.__TAURI__;
});

describe("hub client", () => {
  it("gọi thủ tục của hợp đồng qua lệnh hub_rpc, không gửi token từ giao diện", async () => {
    const calls = fakeTauri(() => ({
      status: 200,
      body: {
        json: [
          {
            id: "t1",
            name: "Thanh toán",
            slug: "thanh-toan",
            color: null,
            createdAt: "2026-10-13T00:00:00.000Z",
            systemCount: 0,
            memberCount: 1,
          },
        ],
      },
    }));
    const teams = await hub.teams.list();
    expect(teams.map((t) => t.name)).toEqual(["Thanh toán"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("hub_rpc");
    expect(String(calls[0]?.args?.path)).toMatch(/^\/rpc\/teams\/list/);
    expect(JSON.stringify(calls[0]?.args)).not.toContain("hive_pat_");
  });

  it("lỗi của hub (đã khai báo) thành lỗi có mã, câu tiếng Việt giữ nguyên", async () => {
    fakeTauri(() => ({
      status: 401,
      body: { json: { defined: true, code: "UNAUTHORIZED", status: 401, message: "Chưa đăng nhập.", data: undefined } },
    }));
    await expect(hub.teams.list()).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "Chưa đăng nhập." });
  });

  it("lệnh Rust báo lỗi (chưa liên kết tài khoản) thì lỗi đi lên cho màn hình", async () => {
    window.__TAURI__ = {
      core: {
        invoke: async () => {
          throw "Chưa liên kết tài khoản.";
        },
      },
    };
    await expect(hub.teams.list()).rejects.toBeTruthy();
  });
});
