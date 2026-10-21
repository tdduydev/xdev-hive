import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DelegationTree } from "@xdev-hive/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "@/lib/hub-query.tsx";
import { setLang } from "@/lib/i18n.ts";
import { DelegationTreeScreen } from "@/screens/delegation-tree-screen.tsx";

const THIS = "8e8e8e8e-0000-4000-8000-000000000001";
const OTHER = "8e8e8e8e-0000-4000-8000-000000000002";
const T1 = "4d4d4d4d-0000-4000-8000-000000000001";
const T2 = "4d4d4d4d-0000-4000-8000-000000000002";
const LOCAL_RUN = "7a7a7a7a-0000-4000-8000-000000000001";
const REMOTE_RUN = "7a7a7a7a-0000-4000-8000-000000000002";

const thread = (id: string, title: string) => ({
  id,
  projectId: null,
  title,
  createdAt: "2026-10-21T01:00:00.000Z",
  updatedAt: "2026-10-21T01:05:00.000Z",
});

const runOn = (id: string, machine: { id: string; name: string }, state: string) => ({
  id,
  kind: "code",
  state,
  attempt: 1,
  parentRunId: null,
  machine,
  cli: "claude",
  account: "Pro",
  startedAt: "2026-10-21T01:00:00.000Z",
  endedAt: null,
  costUsd: 0.2,
  error: null,
  subagents: [],
  subagentsUnsupported: false,
});

const tree = (id: string, title: string, active = true): DelegationTree => ({
  thread: { id, title, createdAt: "2026-10-21T01:00:00.000Z" },
  hidden: 0,
  active,
  tasks: [
    {
      id: "6b6b6b6b-0000-4000-8000-000000000001",
      key: "PAY-1",
      title: "Bảng quyền",
      status: "running",
      projectKey: "PAY",
      createdBy: "leader",
      runs: [
        runOn(LOCAL_RUN, { id: THIS, name: "mac-ha" }, "running"),
        runOn(REMOTE_RUN, { id: OTHER, name: "linux-01" }, "queued"),
      ],
    },
  ],
});

interface Call {
  command: string;
  args?: Record<string, unknown> | undefined;
}

/** Tauri giả: hub sau lệnh hub_rpc theo đường dẫn RPC (GET mang input trong ?data=), `down` thì như hub không tới được. */
function fakeApp(hub: Record<string, (input: unknown) => unknown>) {
  const state = { down: false };
  const calls: Call[] = [];
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    this_machine: () => THIS,
    open_hub_page: () => null,
    hub_rpc: (a) => {
      if (state.down) throw "Không kết nối được hub: connection refused";
      const url = new URL(String(a?.path), "http://hub.local");
      const path = url.pathname.replace(/^\/rpc\//, "");
      const raw = url.searchParams.get("data") ?? (a?.body ? String(a.body) : null);
      const input = raw ? JSON.parse(raw).json : undefined;
      const handler = hub[path];
      return {
        status: handler ? 200 : 404,
        contentType: "application/json",
        body: JSON.stringify({
          json: handler ? handler(input) : { defined: false, code: "NOT_FOUND", status: 404, message: "x" },
        }),
      };
    },
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
  return { calls, state };
}

const HUB = {
  "leader/threads/list": () => [thread(T1, "Phân quyền menu"), thread(T2, "Sửa thanh toán")],
  "leader/tree/get": (input: unknown) => {
    const id = (input as { id: string }).id;
    return id === T1 ? tree(T1, "Phân quyền menu") : tree(T2, "Sửa thanh toán", false);
  },
};

describe("DelegationTreeScreen", () => {
  beforeEach(() => setLang("vi"));

  it("danh sách phiên bên trái, cây của phiên chọn bên phải, run của máy này có dấu", async () => {
    const { calls } = fakeApp(HUB);
    const user = userEvent.setup();
    render(<DelegationTreeScreen />);
    const tree = await screen.findByRole("tree", { name: "Cây giao việc: Phân quyền menu" });
    const nav = screen.getByRole("navigation", { name: "Phiên Leader gần đây" });
    expect(
      within(nav)
        .getByRole("button", { name: /Phân quyền menu/ })
        .getAttribute("aria-current"),
    ).toBe("true");
    const local = within(tree).getByRole("treeitem", { name: "Run Viết code, Đang chạy, máy mac-ha (máy này)" });
    expect(within(local).getByText("máy này")).toBeTruthy();
    const remote = within(tree).getByRole("treeitem", { name: "Run Viết code, Chờ máy, máy linux-01" });
    expect(within(remote).queryByText("máy này")).toBeNull();

    // Run ở máy khác: log nằm ở máy đó, mở trang run trên web.
    await user.click(within(remote).getByRole("button", { name: "Viết code" }));
    expect(calls.find((c) => c.command === "open_hub_page")?.args).toEqual({ path: `/runs/${REMOTE_RUN}` });
    // Run trên máy này: mở màn Agent trên máy, chọn sẵn run.
    await user.click(within(local).getByRole("button", { name: "Viết code" }));
    expect(location.hash).toBe(`#/agents/${LOCAL_RUN}`);

    await user.click(within(nav).getByRole("button", { name: /Sửa thanh toán/ }));
    expect(await screen.findByRole("tree", { name: "Cây giao việc: Sửa thanh toán" })).toBeTruthy();
  });

  it("hub vắng thì báo rõ, không có cây", async () => {
    const { state } = fakeApp(HUB);
    state.down = true;
    render(<DelegationTreeScreen />);
    expect(await screen.findByText("Hub đang vắng")).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("hub mất giữa chừng thì bỏ cây cũ thay vì hiện như mới", async () => {
    const { state } = fakeApp(HUB);
    render(<DelegationTreeScreen />);
    await screen.findByRole("tree", { name: "Cây giao việc: Phân quyền menu" });
    state.down = true;
    await act(() => queryClient.invalidateQueries());
    expect(await screen.findByText("Hub đang vắng")).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("chưa có phiên Leader nào", async () => {
    fakeApp({ "leader/threads/list": () => [] });
    render(<DelegationTreeScreen />);
    expect(await screen.findByText(/Chưa có phiên Leader nào/)).toBeTruthy();
  });
});
