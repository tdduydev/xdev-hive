import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { type Account, AccountContext } from "@/lib/account.ts";
import { setLang } from "@/lib/i18n.ts";
import { stateTone } from "@/lib/run-state.ts";
import { duration, type MachineRun, RunsScreen } from "@/screens/runs-screen.tsx";

const ACCOUNT: Account = {
  name: "Phạm Hà",
  email: "ha@acme.vn",
  orgId: "o1",
  orgName: "Acme",
  orgRole: "member",
  teams: [{ id: "t1", name: "Thanh toán", role: "member" }],
};
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const run = (over: Partial<MachineRun>): MachineRun => ({
  id: "r1",
  kind: "code",
  state: "succeeded",
  taskKey: "PAY-12",
  title: "Sửa làm tròn hoá đơn",
  projectId: "p1",
  project: { key: "PAY", name: "payment-api" },
  cli: "claude",
  model: null,
  machine: "mac-ha",
  costUsd: 0.42,
  tokensIn: 120_000,
  prUrl: null,
  createdAt: iso(3_600_000),
  startedAt: iso(3_600_000),
  finishedAt: iso(3_000_000),
  ...over,
});

function fakeTauri(runs: MachineRun[], machine: string | null = "mac-ha") {
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    this_machine: () => machine,
    worker_state: () => ({ kind: "online", label: "Worker: đang nhận việc" }),
    hub_tool: (args) => {
      if (args?.name === "run_list") return { runs };
      throw new Error(`tool chưa giả: ${String(args?.name)}`);
    },
    open_hub_page: () => null,
  };
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const h = handlers[command];
        if (!h) throw new Error(`lệnh chưa giả: ${command}`);
        return (await h(args)) as T;
      },
    },
    event: { listen: async () => () => {} },
  };
  return calls;
}

const renderRuns = (account: Account | null = ACCOUNT) =>
  render(
    <AccountContext.Provider value={account}>
      <RunsScreen />
    </AccountContext.Provider>,
  );

describe("hàm của màn Lượt chạy", () => {
  it("thời lượng và màu trạng thái", () => {
    expect(duration({ startedAt: "2026-10-12T00:00:00Z", finishedAt: "2026-10-12T00:05:00Z" })).toBe(300);
    expect(duration({ startedAt: null, finishedAt: null })).toBeNull();
    expect(stateTone("running")).toBe("sel");
    expect(stateTone("failed")).toBe("bad");
    expect(stateTone("needs_review")).toBe("warn");
  });
});

describe("RunsScreen", () => {
  beforeEach(() => setLang("vi"));

  it("lấy run của chính máy này, hiện số liệu 24 giờ và mở run trên web của hub", async () => {
    const calls = fakeTauri([
      run({
        id: "r2",
        state: "running",
        taskKey: "PAY-13",
        finishedAt: null,
        costUsd: null,
        createdAt: iso(60_000),
        startedAt: iso(60_000),
      }),
      run({}),
      run({ id: "r3", taskKey: "PAY-1", createdAt: iso(3 * 86_400_000), startedAt: iso(3 * 86_400_000), costUsd: 9 }),
    ]);
    renderRuns();
    const row = (await screen.findByRole("button", { name: "Mở PAY-12 trên web" })).closest("tr") as HTMLElement;
    expect(within(row).getByText("payment-api")).toBeTruthy();
    expect(within(row).getByText("Xong")).toBeTruthy();
    expect(within(row).getByText("10 phút")).toBeTruthy();
    expect(within(row).getByText("$0.42")).toBeTruthy();
    expect(screen.getByText("1 run đang chạy")).toBeTruthy();
    expect(screen.getByText("2 run trong 24 giờ")).toBeTruthy();
    expect(screen.getByText("$0.42", { selector: "span" })).toBeTruthy();
    expect(calls.find((c) => c.command === "hub_tool")?.args).toEqual({
      name: "run_list",
      args: { machine: "mac-ha", limit: 50 },
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Mở PAY-12 trên web" }));
    expect(calls.find((c) => c.command === "open_hub_page")?.args).toEqual({ path: "/runs/r1" });
  });

  it("chưa đăng ký máy hoặc chưa liên kết tài khoản thì nhắc, không gọi hub", async () => {
    let calls = fakeTauri([], null);
    renderRuns();
    expect(await screen.findAllByText(/Máy chưa đăng ký với hub/)).not.toHaveLength(0);
    expect(calls.some((c) => c.command === "hub_tool")).toBe(false);
    calls = fakeTauri([]);
    renderRuns(null);
    expect((await screen.findAllByText("Kết nối Hive để xem run của máy này.")).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.command === "hub_tool")).toBe(false);
  });

  it("máy chưa chạy gì; tiếng Anh", async () => {
    setLang("en");
    fakeTauri([]);
    renderRuns();
    expect(await screen.findByText("This machine has not run anything yet.")).toBeTruthy();
  });
});
