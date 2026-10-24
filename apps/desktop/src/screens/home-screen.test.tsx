import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { type Account, AccountContext } from "@/lib/account.ts";
import { saveFolder } from "@/lib/folder.ts";
import { setLang } from "@/lib/i18n.ts";
import type { MachineRun } from "@/lib/machine-runs.ts";
import type { Plan } from "@/lib/plans.ts";
import type { SessionStats } from "@/lib/usage.ts";
import { HomeScreen, lastLines, runsToday, tokensToday, untilText } from "@/screens/home-screen.tsx";

const ACCOUNT: Account = {
  name: "Trần Lan",
  email: "lan@acme.vn",
  orgId: "o1",
  orgName: "Acme",
  orgRole: "member",
  teams: [{ id: "t1", name: "Thanh toán", role: "member" }],
};

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function run(over: Partial<MachineRun>): MachineRun {
  return {
    id: "7f3a21c0-0000-4000-8000-000000000000",
    kind: "code",
    state: "succeeded",
    taskKey: "PAY-138",
    title: "Sửa tiền tệ",
    projectId: "p",
    project: { key: "PAY", name: "payment-api" },
    cli: "claude",
    model: "sonnet",
    machine: "dev-ha",
    costUsd: 0.5,
    tokensIn: 1000,
    prUrl: null,
    createdAt: iso(60_000),
    startedAt: iso(60_000),
    finishedAt: iso(30_000),
    ...over,
  };
}

const RUNS: MachineRun[] = [
  run({
    id: "7f3a21c0-aaaa-4000-8000-000000000000",
    state: "running",
    taskKey: "PAY-139",
    title: "Retry webhook khi cổng thanh toán trả 502",
    costUsd: 0.31,
    startedAt: iso(6 * 60_000),
    finishedAt: null,
  }),
  run({ id: "b", state: "succeeded", costUsd: 1.5 }),
  run({ id: "c", state: "failed", costUsd: null }),
];

const PLANS: Plan[] = [
  {
    id: "max",
    label: "Claude Max team",
    cli: "claude",
    enabled: true,
    priority: 1,
    maxConcurrent: 2,
    cooldownMinutes: 5,
    supported: true,
    loggedIn: true,
    usage: {
      session: { percent: 32, resetsAt: new Date(NOW + 190 * 60_000).toISOString() },
      week: { percent: 58, resetsAt: null },
      checkedAt: iso(0),
      reason: null,
    },
  },
  {
    id: "gm",
    label: "Gemini",
    cli: "gemini",
    enabled: false,
    priority: 2,
    maxConcurrent: 1,
    cooldownMinutes: 5,
    supported: true,
    loggedIn: null,
  },
];

const STATS: SessionStats = {
  totals: { sessions: 2, input: 3_000_000, cached: 2_000_000, output: 0 },
  sessions: [
    {
      id: "s1",
      at: iso(0),
      cwd: "/w",
      model: null,
      input: 1_000_000,
      cached: 750_000,
      output: 0,
      contextUsed: null,
      contextWindow: null,
    },
    {
      id: "old",
      at: iso(3 * 86_400_000),
      cwd: "/w",
      model: null,
      input: 2_000_000,
      cached: 1_250_000,
      output: 0,
      contextUsed: null,
      contextWindow: null,
    },
  ],
  primary: null,
  secondary: null,
};

const CHECKS = [
  {
    id: "git",
    name: "Git",
    kind: "tool",
    required: true,
    need: null,
    have: "2.5",
    status: "ok",
    source: "",
    install: null,
  },
  {
    id: "go",
    name: "Go",
    kind: "runtime",
    required: true,
    need: "1.27",
    have: "1.25.4",
    status: "outdated",
    source: "go.mod",
    install: null,
  },
  {
    id: "lint",
    name: "golangci-lint",
    kind: "tool",
    required: true,
    need: "2.x",
    have: null,
    status: "missing",
    source: "",
    install: null,
  },
];

const ONLINE = {
  kind: "online",
  label: "Worker: đang nhận việc",
  detail: null,
  wanted: true,
  hub: "https://hive.acme.vn",
};

type Handlers = Record<string, (args?: Record<string, unknown>) => unknown>;

const logChunk = (text: string) => ({
  id: 1,
  attempt: 1,
  offset: 0,
  bytes: btoa(String.fromCharCode(...new TextEncoder().encode(text))),
  createdAt: iso(0),
});

function fakeTauri(over: Handlers = {}) {
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  const handlers: Handlers = {
    worker_state: () => ONLINE,
    this_machine: () => "dev-ha",
    "plugin:app|version": () => "0.9.4",
    hub_tool: (args) => {
      if (args?.name === "run_list") return { runs: RUNS };
      throw new Error(`tool chưa giả: ${String(args?.name)}`);
    },
    read_run_log: () => ({
      runId: RUNS[0]?.id,
      attempt: 1,
      offset: 0,
      nextOffset: 100,
      size: 100,
      bytes: logChunk("tool Edit retry.ts\n\ntool Bash pnpm test\ntest 12 đạt\nagent Thêm backoff\n").bytes,
    }),
    cli_profiles: () => ({ path: "/x/accounts.json", accounts: PLANS }),
    scan_environment: () => CHECKS,
    session_stats: () => STATS,
    remote_status: () => ({ enabled: true, devices: [{ id: "d" }], roots: [] }),
    remote_disable: () => ({ enabled: false, devices: [], roots: [] }),
    remote_sessions: () => [
      { id: "s", cli: "claude", cwd: "/w", account: "max", started: iso(0), controlled: false, viewers: 1 },
    ],
    workspace_meta: () => ({
      folder: "/w/payment-api",
      name: "payment-api",
      isGit: true,
      branch: "main",
      remote: null,
    }),
    local_projects: () => ({
      path: "",
      exists: true,
      imported: 0,
      projects: [
        {
          projectId: "p",
          name: "PAY",
          folder: "/w/payment-api",
          fullPermission: false,
          exists: true,
          isGit: true,
        },
      ],
    }),
    set_worker: (args) => ({ ...ONLINE, wanted: args?.on }),
    ...over,
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
  };
  return calls;
}

const renderHome = (account: Account | null = ACCOUNT) =>
  render(
    <AccountContext.Provider value={account}>
      <HomeScreen />
    </AccountContext.Provider>,
  );

describe("số liệu của màn Máy này", () => {
  it("chỉ tính run tạo từ nửa đêm, run đang chạy tính cả cũ", () => {
    const yesterday = new Date(NOW);
    yesterday.setHours(0, 0, 0, 0);
    const old = run({ id: "old", state: "running", createdAt: new Date(yesterday.getTime() - 1000).toISOString() });
    const today = runsToday([...RUNS, old], NOW);
    expect(today.count).toBe(3);
    expect(today.active.map((r) => r.id)).toEqual([RUNS[0]?.id, "old"]);
    expect(today.ok).toBe(1);
    expect(today.look).toBe(1);
    expect(today.cost).toBeCloseTo(1.81);
    expect(today.costed).toBe(2);
  });

  it("token hôm nay chỉ cộng phiên hôm nay", () => {
    expect(tokensToday(STATS, NOW)).toEqual({ input: 1_000_000, cached: 750_000 });
  });

  it("thời gian tới lúc làm mới", () => {
    expect(untilText(new Date(NOW + 190 * 60_000).toISOString(), NOW, "vi")).toBe("3 giờ 10 phút");
    expect(untilText(new Date(NOW + 45 * 60_000).toISOString(), NOW, "en")).toBe("45 min");
    expect(untilText(new Date(NOW - 1000).toISOString(), NOW, "vi")).toBeNull();
  });

  it("vài dòng log cuối, bỏ dòng trống", () => {
    expect(lastLines("a\n\nb\nc\nd\ne\n")).toEqual(["b", "c", "d", "e"]);
  });
});

describe("HomeScreen", () => {
  beforeEach(() => {
    setLang("vi");
    saveFolder("/w/payment-api");
  });

  it("worker, run đang chạy với log, hạn mức gói, môi trường, điều khiển từ xa và thư mục", async () => {
    const calls = fakeTauri();
    renderHome();
    const machine = await screen.findByRole("region", { name: "Máy này" });
    expect(await within(machine).findByText("dev-ha")).toBeTruthy();
    expect(within(machine).getByText("Đang nhận việc")).toBeTruthy();
    expect(await within(machine).findByText("nối với hive.acme.vn · app 0.9.4")).toBeTruthy();

    const current = screen.getByRole("region", { name: "Đang chạy trên máy" });
    expect(await within(current).findByText("Retry webhook khi cổng thanh toán trả 502")).toBeTruthy();
    expect(within(current).getByText("PAY-139 · run 7f3a21c0")).toBeTruthy();
    const log = await within(current).findByLabelText("Log gần nhất");
    await waitFor(() =>
      expect(log.textContent).toBe("tool Edit retry.ts\ntool Bash pnpm test\ntest 12 đạt\nagent Thêm backoff"),
    );
    expect(calls.some((c) => c.command === "read_run_log")).toBe(true);
    expect(calls.some((c) => c.command === "hub_rpc" && String(c.args?.path).includes("logs"))).toBe(false);

    expect(screen.getByText("Run hôm nay").parentElement?.textContent).toContain("1 thành công · 1 cần xem");
    expect(screen.getByText("Chi phí hôm nay").parentElement?.textContent).toContain("1,81 USD");
    expect(await screen.findByText("1M")).toBeTruthy();
    expect(screen.getByText("cache trúng 75%")).toBeTruthy();

    const quotas = screen.getByRole("region", { name: "Hạn mức gói agent" });
    expect(await within(quotas).findByText("Claude Max team")).toBeTruthy();
    expect(within(quotas).getByText("làm mới sau 3 giờ 10 phút")).toBeTruthy();
    expect(within(quotas).getByRole("meter", { name: "Phiên 5 giờ" }).getAttribute("aria-valuenow")).toBe("32");
    expect(within(quotas).getByRole("meter", { name: "Tuần" }).getAttribute("aria-valuenow")).toBe("58");
    expect(within(quotas).getByText("Đã tắt")).toBeTruthy();

    const env = screen.getByRole("region", { name: "Môi trường" });
    expect(await within(env).findByText("2 mục cần xử lý")).toBeTruthy();
    expect(within(env).getByText("cần 1.27 · máy có 1.25.4")).toBeTruthy();
    expect(within(env).getByText("cần 2.x · chưa cài")).toBeTruthy();
    expect(within(env).getByRole("link", { name: "Xem 2 mục cần sửa" }).getAttribute("href")).toBe("#/setup");

    const folder = screen.getByRole("region", { name: "Thư mục đang làm" });
    expect(await within(folder).findByText("Toàn quyền tắt")).toBeTruthy();
    expect(within(folder).getByText(/nhánh main/)).toBeTruthy();

    const remote = screen.getByRole("region", { name: "Điều khiển từ xa" });
    expect(await within(remote).findByText("Đang bật")).toBeTruthy();
    expect(await within(remote).findByText("1 thiết bị đã ghép · 1 đang xem")).toBeTruthy();
    await userEvent.setup().click(within(remote).getByRole("button", { name: "Tắt điều khiển từ xa ngay" }));
    expect(await within(remote).findByText("Đã tắt")).toBeTruthy();
    expect(calls.some((c) => c.command === "remote_disable")).toBe(true);
    // Máy nối bình thường thì không có lời báo mất kết nối.
    expect(screen.queryByText(/Worker mất kết nối với hub hơn 1 phút/)).toBeNull();
  });

  it("log không có ở máy này: báo nơi giữ và không gọi log của hub", async () => {
    const calls = fakeTauri({
      read_run_log: () => {
        throw new Error("Log không có trên máy này.");
      },
    });
    renderHome();
    expect(await screen.findByText(/Log nằm trên máy/)).toBeTruthy();
    expect(calls.some((c) => c.command === "hub_rpc")).toBe(false);
  });

  it("thẻ Agent đang chạy đếm theo CLI và mở màn Agent trên máy", async () => {
    fakeTauri({ machine_agent_counts: () => ({ claude: 12, codex: 1, antigravity: 0 }) });
    renderHome();
    const card = await screen.findByRole("region", { name: "Agent đang chạy" });
    await waitFor(() => expect(within(card).getByText("Claude Code").parentElement?.textContent).toContain("12"));
    expect(within(card).getByText("Codex").parentElement?.textContent).toContain("1");
    expect(within(card).getByText("Antigravity").parentElement?.textContent).toContain("0");
    expect(within(card).getByRole("link", { name: "Xem chi tiết" }).getAttribute("href")).toBe("#/agents");
  });

  it("nút Tắt worker gọi set_worker", async () => {
    const calls = fakeTauri();
    renderHome();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Tắt worker" }));
    expect(calls.find((c) => c.command === "set_worker")?.args).toEqual({ on: false });
  });

  it("mất kết nối quá 1 phút: báo, và nhắc các mục trên máy vẫn dùng được", async () => {
    fakeTauri({
      worker_state: () => ({
        kind: "disconnected",
        label: "Worker: mất kết nối, đang thử lại",
        detail: null,
        wanted: true,
        hub: "https://hive.acme.vn",
        offlineSince: Math.floor((NOW - 120_000) / 1000),
      }),
    });
    renderHome();
    expect(
      (await screen.findByRole("alert")).textContent?.startsWith(
        "Worker mất kết nối với hub hơn 1 phút. Máy này tạm không nhận việc.",
      ),
    ).toBe(true);
    expect(
      screen.getByText(
        "Không đăng nhập vẫn dùng được các mục trên máy: gói agent, dự án, môi trường, skills, token và tài liệu từ code.",
      ),
    ).toBeTruthy();
    const local = screen.getByRole("region", { name: "Vẫn dùng được khi không có hub" });
    expect(within(local).getByRole("link", { name: "Gói agent" }).getAttribute("href")).toBe("#/plans");
    expect(screen.getByText("Mất kết nối, đang thử lại")).toBeTruthy();
  });

  it("mới mất kết nối chưa tới 1 phút thì chưa báo", async () => {
    fakeTauri({
      worker_state: () => ({ ...ONLINE, kind: "connecting", offlineSince: Math.floor(NOW / 1000) }),
    });
    renderHome();
    expect(await screen.findByText("Đang nối với hub")).toBeTruthy();
    expect(screen.queryByText(/Worker mất kết nối với hub hơn 1 phút/)).toBeNull();
  });

  it("chưa đăng nhập: không gọi hub, ô run mời kết nối, phần trên máy vẫn hiện", async () => {
    const calls = fakeTauri();
    renderHome(null);
    expect((await screen.findAllByText("Kết nối Hive để xem run của máy này.")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Không đăng nhập vẫn dùng được các mục trên máy/)).toBeTruthy();
    expect(await screen.findByText("Claude Max team")).toBeTruthy();
    expect(await screen.findByText("2 mục cần xử lý")).toBeTruthy();
    expect(calls.some((c) => c.command === "hub_tool" || c.command === "hub_rpc")).toBe(false);
  });

  it("người xem đội: không có worker, gói, môi trường; token và thư mục vẫn có", async () => {
    const calls = fakeTauri();
    renderHome({ ...ACCOUNT, teams: [{ id: "t1", name: "Thanh toán", role: "viewer" }] });
    expect(await screen.findByText("Token hôm nay")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Thư mục đang làm" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Máy này" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Môi trường" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Hạn mức gói agent" })).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.command === "session_stats")).toBe(true));
    expect(calls.some((c) => c.command === "scan_environment" || c.command === "cli_profiles")).toBe(false);
  });

  it("đọc lỗi thì báo lý do ngắn, không kẹt Đang đọc", async () => {
    fakeTauri({
      cli_profiles: () => Promise.reject("Không chạy được worker"),
      scan_environment: () => Promise.reject("Không chạy được lệnh kiểm tra."),
      session_stats: () => Promise.reject("Không đọc được ~/.claude."),
      remote_status: () => Promise.reject("Không có hive"),
    });
    renderHome();
    expect(await screen.findByText("Không đọc được gói agent")).toBeTruthy();
    expect(await screen.findByText("Không kiểm được máy")).toBeTruthy();
    expect(await screen.findByText("Không đọc được phiên trên máy")).toBeTruthy();
    expect(await screen.findByText("Không đọc được trạng thái điều khiển từ xa")).toBeTruthy();
  });

  it("chưa chọn thư mục: mời chọn thư mục, Rust chỉ kiểm công cụ chung của máy", async () => {
    saveFolder("");
    const calls = fakeTauri();
    renderHome();
    const folder = screen.getByRole("region", { name: "Thư mục đang làm" });
    expect(within(folder).getByText("Chưa chọn thư mục làm việc.")).toBeTruthy();
    expect(within(folder).getByRole("button", { name: "Chọn thư mục" })).toBeTruthy();
    await screen.findByText("2 mục cần xử lý");
    expect(calls.find((c) => c.command === "scan_environment")?.args).toEqual({ folder: null, project: null });
    expect(calls.some((c) => c.command === "workspace_meta")).toBe(false);
  });
});
