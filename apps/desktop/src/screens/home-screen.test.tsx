import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { type Account, AccountContext } from "@/lib/account.ts";
import { saveFolder } from "@/lib/folder.ts";
import { type HubProject, matchProject, normalizeRepo } from "@/lib/hub.ts";
import { setLang } from "@/lib/i18n.ts";
import type { SessionStats } from "@/lib/usage.ts";
import { HomeScreen, tokensByDay } from "@/screens/home-screen.tsx";

const ACCOUNT: Account = {
  name: "Phạm Hà",
  email: "ha@acme.vn",
  orgId: "o1",
  orgName: "Acme",
  orgRole: "member",
  teams: [{ id: "t1", name: "Thanh toán", role: "member" }],
};
const PROJECT: HubProject = {
  key: "PAY",
  name: "payment-api",
  state: "active",
  repo: {
    kind: "github",
    owner: "acme",
    name: "payment-api",
    httpUrl: "https://github.com/acme/payment-api.git",
    sshUrl: "git@github.com:acme/payment-api.git",
    webUrl: "https://github.com/acme/payment-api",
  },
};
const now = new Date().toISOString();
const STATS: SessionStats = {
  totals: { sessions: 1, input: 2_000_000, cached: 1_500_000, output: 1_000 },
  sessions: [
    {
      id: "s",
      at: now,
      cwd: "/w/payment-api",
      model: "claude-opus-5-5",
      input: 2_000_000,
      cached: 1_500_000,
      output: 1_000,
      contextUsed: null,
      contextWindow: null,
    },
  ],
  primary: null,
  secondary: null,
};

type Handlers = Record<string, (args?: Record<string, unknown>) => unknown>;

function fakeTauri(docsVersion = 7, over: Handlers = {}) {
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  const handlers: Handlers = {
    workspace_meta: () => ({
      folder: "/w/payment-api",
      name: "payment-api",
      isGit: true,
      branch: "main",
      remote: "git@github.com:Acme/payment-api.git",
    }),
    scan_environment: () => [
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
        need: "≥ 1.27",
        have: "1.25.4",
        status: "outdated",
        source: "go.mod",
        install: null,
      },
    ],
    session_stats: () => STATS,
    hub_tool: (args) => {
      const name = args?.name;
      if (name === "project_list") return { projects: [PROJECT] };
      if (name === "doc_list")
        return {
          docs: [
            { key: "pay/money", title: "Quy ước tiền tệ", version: docsVersion, updatedAt: now },
            { key: "pay/api", title: "Hướng dẫn thiết kế API", version: 3, updatedAt: now },
          ],
        };
      if (name === "skill_list")
        return { skills: [{ name: "db-migration", description: "", scope: "org", version: 1 }] };
      throw new Error(`tool chưa giả: ${String(name)}`);
    },
    worker_state: () => ({
      kind: "online",
      label: "Worker: đang nhận việc",
      detail: null,
      wanted: true,
      hub: "https://hive.acme.vn",
    }),
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

describe("so thư mục với dự án", () => {
  it("https và ssh của cùng một repo khớp nhau", () => {
    expect(normalizeRepo("https://github.com/Acme/payment-api.git")).toBe("github.com/acme/payment-api");
    expect(normalizeRepo("git@github.com:acme/payment-api.git")).toBe("github.com/acme/payment-api");
    expect(normalizeRepo("ssh://git@github.com/acme/payment-api")).toBe("github.com/acme/payment-api");
    expect(matchProject("git@github.com:acme/payment-api.git", [PROJECT])?.key).toBe("PAY");
    expect(matchProject("git@github.com:acme/other.git", [PROJECT])).toBeNull();
    expect(matchProject(null, [PROJECT])).toBeNull();
  });

  it("cộng token theo 7 ngày, ngày cũ trước", () => {
    const days = tokensByDay(STATS);
    expect(days).toHaveLength(7);
    expect(days.at(-1)?.input).toBe(2_000_000);
    expect(days[0]?.input).toBe(0);
  });
});

describe("HomeScreen", () => {
  beforeEach(() => {
    setLang("vi");
    saveFolder("/w/payment-api");
  });

  it("nhận ra dự án, hiện số liệu thật và tài liệu; đánh dấu đã đọc", async () => {
    const calls = fakeTauri();
    renderHome();
    expect(await screen.findByText(/đã nối với dự án payment-api trên hub/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Chào Phạm Hà" })).toBeTruthy();
    expect(await screen.findByText("Quy ước tiền tệ")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByText("1 mục cần cài")).toBeTruthy();
    expect(screen.getByText("2M")).toBeTruthy();
    expect(screen.getByText("cache trúng 75%")).toBeTruthy();
    expect(screen.getByText("lần đầu mở trên máy này")).toBeTruthy();
    expect(calls.find((c) => c.command === "hub_tool" && c.args?.name === "doc_list")?.args).toEqual({
      name: "doc_list",
      args: { prefix: "project/PAY/" },
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Đánh dấu đã đọc" }));
    expect(screen.getByText("không có gì mới")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("hive.home.seen") ?? "{}")).toEqual({
      PAY: { "pay/money": 7, "pay/api": 3 },
    });
  });

  it("tài liệu có bản mới so với lần đọc trước thì báo đổi từ bản cũ", async () => {
    localStorage.setItem("hive.home.seen", JSON.stringify({ PAY: { "pay/money": 6, "pay/api": 3 } }));
    fakeTauri(7);
    renderHome();
    const item = (await screen.findByText("Quy ước tiền tệ")).closest("li") as HTMLElement;
    expect(within(item).getByText("Đổi từ v6")).toBeTruthy();
    const tile = screen.getByText("Tài liệu đổi từ lần trước").parentElement as HTMLElement;
    expect(within(tile).getByText("1")).toBeTruthy();
  });

  it("người viết tài liệu không thấy phần môi trường của máy", async () => {
    const calls = fakeTauri();
    renderHome({ ...ACCOUNT, teams: [{ id: "t1", name: "Thanh toán", role: "viewer" }] });
    await screen.findByText("Quy ước tiền tệ");
    expect(screen.queryByText("Máy sẵn sàng")).toBeNull();
    expect(screen.queryByText("Máy này còn thiếu")).toBeNull();
    expect(calls.some((c) => c.command === "scan_environment")).toBe(false);
  });

  it("chưa liên kết tài khoản: không gọi hub, nhắc liên kết", async () => {
    const calls = fakeTauri();
    renderHome(null);
    expect((await screen.findAllByText("Kết nối Hive để xem tài liệu và skill của dự án.")).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.command === "hub_tool")).toBe(false);
  });

  it("chưa chọn thư mục: vẫn hiện máy, worker, token và tài liệu trên hub; chỉ ô skill mời chọn thư mục", async () => {
    saveFolder("");
    const calls = fakeTauri();
    renderHome();
    expect(await screen.findByText("Quy ước tiền tệ")).toBeTruthy();
    expect(screen.getByText(/Chưa chọn thư mục làm việc: số liệu dưới đây tính trên cả máy/)).toBeTruthy();
    // Máy, worker, token tải bằng các lệnh Tauri riêng, không cùng lúc với tài liệu trên hub.
    expect(await screen.findByText("1/2")).toBeTruthy();
    expect(await screen.findByText("Đang chạy")).toBeTruthy();
    expect(await screen.findByText("hive.acme.vn")).toBeTruthy();
    expect(await screen.findByText("2M")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tài liệu trên hub" })).toBeTruthy();
    const skills = screen.getByText("Skill áp cho thư mục").parentElement as HTMLElement;
    expect(within(skills).getByText("—")).toBeTruthy();
    expect(within(skills).getByText("Chọn thư mục để xem skill của dự án")).toBeTruthy();
    expect(within(skills).getByRole("button", { name: "Chọn thư mục" })).toBeTruthy();
    expect(screen.getByText(/Mới kiểm công cụ chung của máy/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Đang đọc…")).toBeNull());
    await waitFor(() => expect(screen.queryByText("Đang kiểm tra…")).toBeNull());
    expect(calls.find((c) => c.command === "scan_environment")?.args).toEqual({ folder: null, project: null });
    expect(calls.find((c) => c.command === "session_stats")?.args).toEqual({ engine: "claude", folder: null });
    expect(calls.find((c) => c.args?.name === "doc_list")?.args).toEqual({ name: "doc_list", args: {} });
    expect(calls.some((c) => c.command === "workspace_meta")).toBe(false);
    expect(calls.some((c) => c.args?.name === "skill_list")).toBe(false);
  });

  it("chọn thư mục ngay trong ô skill thì đọc dự án của thư mục đó", async () => {
    saveFolder("");
    const calls = fakeTauri(7, { "plugin:dialog|open": () => "/w/payment-api" });
    renderHome();
    const skillsTile = () => screen.getByText("Skill áp cho thư mục").parentElement as HTMLElement;
    await userEvent.setup().click(within(skillsTile()).getByRole("button", { name: "Chọn thư mục" }));
    expect(await screen.findByText(/đã nối với dự án payment-api trên hub/)).toBeTruthy();
    expect(localStorage.getItem("hive.folder")).toBe("/w/payment-api");
    // Có thư mục thì ô thành link sang màn Skills, không còn nút chọn.
    expect(await within(skillsTile()).findByText("1")).toBeTruthy();
    expect(skillsTile().tagName).toBe("A");
    expect(calls.find((c) => c.command === "workspace_meta")?.args).toEqual({ folder: "/w/payment-api" });
  });

  it("lỗi hoặc không có dữ liệu: ô hiện — và lý do, không kẹt Đang đọc", async () => {
    fakeTauri(7, {
      scan_environment: () => Promise.reject("Không chạy được lệnh kiểm tra."),
      session_stats: () => ({ ...STATS, totals: { sessions: 0, input: 0, cached: 0, output: 0 }, sessions: [] }),
      hub_tool: () => Promise.reject("Hub không trả lời."),
      worker_state: () => Promise.reject("lệnh chưa giả"),
    });
    renderHome();
    expect(await screen.findByText("Không kiểm được máy")).toBeTruthy();
    expect(screen.getByText("Không kiểm được máy").getAttribute("title")).toBe("Không chạy được lệnh kiểm tra.");
    expect(await screen.findByText("chưa có phiên nào trong 7 ngày")).toBeTruthy();
    expect((await screen.findAllByText("Không đọc được hub")).length).toBe(2);
    expect(screen.getByText("không đọc được trạng thái")).toBeTruthy();
    expect(screen.getAllByText("Hub không trả lời.").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByText("Đang đọc…")).toBeNull());
    await waitFor(() => expect(screen.queryByText("Đang kiểm tra…")).toBeNull());
  });

  it("thư mục không đọc được: báo lỗi thư mục, phần còn lại vẫn chạy", async () => {
    saveFolder("/khong-co");
    fakeTauri(7, { workspace_meta: () => Promise.reject("Không tìm thấy thư mục /khong-co.") });
    renderHome();
    expect((await screen.findAllByText("Không đọc được thư mục khong-co.")).length).toBe(2);
    expect(await screen.findByText("Quy ước tiền tệ")).toBeTruthy();
    expect(await screen.findByText("2M")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Đang đọc…")).toBeNull());
  });

  it("phiên trên máy đọc lỗi: ô token và biểu đồ báo lý do", async () => {
    fakeTauri(7, { session_stats: () => Promise.reject("Không đọc được ~/.claude.") });
    renderHome();
    expect((await screen.findAllByText("Không đọc được phiên trên máy")).length).toBe(2);
    expect(screen.queryByRole("img", { name: "Token 7 ngày" })).toBeNull();
  });
});
