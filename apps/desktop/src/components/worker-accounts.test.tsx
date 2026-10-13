import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkerAccounts } from "@/components/worker-accounts.tsx";
import { setLang } from "@/lib/i18n.ts";

const base = { priority: 0, maxConcurrent: 1, cooldownMinutes: 60 };
const profiles = (enabled4: boolean) => ({
  path: "/x/accounts.json",
  accounts: [
    {
      ...base,
      id: "claude-3",
      label: "claude-3",
      cli: "claude",
      configDir: "~/.xdev-hive/accounts/claude-3",
      enabled: true,
      priority: 30,
      supported: true,
      loggedIn: true,
      email: "duy@example.com",
    },
    {
      ...base,
      id: "claude-4",
      label: "vudd7",
      cli: "claude",
      configDir: "~/.xdev-hive/accounts/claude-4",
      enabled: enabled4,
      maxConcurrent: 3,
      supported: true,
      loggedIn: true,
    },
    { ...base, id: "claude-9", label: "claude-9", cli: "claude", enabled: false, supported: true, loggedIn: false },
    {
      ...base,
      id: "antigravity-1",
      label: "anti-tdduydev",
      cli: "antigravity",
      enabled: true,
      priority: 35,
      supported: false,
      loggedIn: null,
    },
  ],
});

function fakeTauri() {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  let enabled4 = true;
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, ...(args ? { args } : {}) });
        if (command === "cli_profile_set") enabled4 = Boolean(args?.enabled);
        if (command === "cli_profiles" || command === "cli_profile_set") return profiles(enabled4) as T;
        throw new Error(`lệnh chưa giả: ${command}`);
      },
    },
  };
  return calls;
}

describe("WorkerAccounts", () => {
  beforeEach(() => setLang("vi"));

  it("liệt kê tài khoản đã mang sang, trạng thái đăng nhập và CLI worker chưa chạy", async () => {
    fakeTauri();
    render(<WorkerAccounts />);
    expect(await screen.findByText("vudd7")).toBeTruthy();
    expect(screen.getByText(/duy@fpt\.com/)).toBeTruthy();
    expect(screen.getByText(/tối đa 3 run cùng lúc/)).toBeTruthy();
    expect(screen.getByText("Chưa đăng nhập")).toBeTruthy();
    expect(screen.getByText("Worker chưa chạy CLI này")).toBeTruthy();
    // CLI worker không chạy thì không bật tắt được.
    expect((screen.getByLabelText("Dùng tài khoản anti-tdduydev") as HTMLInputElement).disabled).toBe(true);
  });

  it("bỏ chọn một tài khoản thì gửi lệnh tắt đúng tài khoản đó", async () => {
    const calls = fakeTauri();
    render(<WorkerAccounts />);
    const box = (await screen.findByLabelText("Dùng tài khoản vudd7")) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.setup().click(box);
    expect(calls.find((c) => c.command === "cli_profile_set")?.args).toEqual({ id: "claude-4", enabled: false });
    expect(((await screen.findByLabelText("Dùng tài khoản vudd7")) as HTMLInputElement).checked).toBe(false);
  });

  it("chưa có tài khoản nào thì nói rõ worker dùng đăng nhập mặc định", async () => {
    window.__TAURI__ = { core: { invoke: async <T,>() => ({ path: "/x", accounts: [] }) as T } };
    render(<WorkerAccounts />);
    expect(await screen.findByText(/worker dùng đăng nhập mặc định/)).toBeTruthy();
  });
});
