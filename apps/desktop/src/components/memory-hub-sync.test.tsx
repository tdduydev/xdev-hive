import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryHubSync } from "@/components/memory-hub-sync.tsx";
import { type Account, AccountContext } from "@/lib/account.ts";
import { queryClient } from "@/lib/hub-query.tsx";
import { setLang } from "@/lib/i18n.ts";

const ACCOUNT: Account = {
  name: "Phạm Hà",
  email: "ha@acme.vn",
  orgId: "o1",
  orgName: "Acme",
  orgRole: "member",
  teams: [{ id: "t1", name: "Thanh toán", role: "member" }],
};
const at = "2026-10-13T00:00:00.000Z";
const PROJECT_ID = "0a0a0a0a-0000-4000-8000-000000000001";
const by = { userId: "u1", runId: null };
const scope = { level: "project", teamId: null, projectId: PROJECT_ID };

const brief = {
  projectId: PROJECT_ID,
  content: "## Tổng quan\n\nDịch vụ thanh toán.",
  version: 2,
  commitSha: null,
  source: "user",
  updatedBy: by,
  updatedAt: at,
  headSha: null,
  commitsBehind: null,
  refreshRunId: null,
};
const approved = {
  id: "0a0a0a0a-0000-4000-8000-000000000004",
  kind: "decision",
  status: "approved",
  content: "Hoàn tiền đi qua bảng refunds.",
  files: [],
  scope,
  author: by,
  createdAt: at,
  supersededBy: null,
};
const hubProject = { id: PROJECT_ID, key: "pay", name: "Pay" };

/** Hub giả sau lệnh hub_rpc; ghi lại thủ tục và thân request. */
function fakeHub(replies: Record<string, unknown>) {
  const calls: { path: string; body: unknown }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command !== "hub_rpc") throw new Error(`lệnh chưa giả: ${command}`);
        const path = String(args?.path)
          .replace(/^\/rpc\//, "")
          .split("?")[0] as string;
        calls.push({ path, body: args?.body ? JSON.parse(String(args.body)).json : null });
        const body = replies[path];
        return {
          status: body === undefined ? 404 : 200,
          contentType: "application/json",
          body: JSON.stringify(
            body === undefined
              ? { json: { defined: false, code: "NOT_FOUND", status: 404, message: "x" } }
              : { json: body },
          ),
        } as T;
      },
    },
  };
  return calls;
}

const renderSync = (account: Account | null, items = [{ id: "a.md", label: "a.md", content: "Dùng pnpm." }]) =>
  render(
    <AccountContext.Provider value={account}>
      <MemoryHubSync projectKey="pay" items={items} />
    </AccountContext.Provider>,
  );

describe("MemoryHubSync", () => {
  beforeEach(() => {
    setLang("vi");
    queryClient.clear();
  });

  it("chưa đăng nhập thì ẩn hẳn và không gọi hub", () => {
    const calls = fakeHub({});
    const { container } = renderSync(null);
    expect(container.innerHTML).toBe("");
    expect(calls).toEqual([]);
  });

  it("hiện brief và memory của dự án để đọc", async () => {
    fakeHub({ "briefs/get": brief, "memory/list": [approved], "projects/list": [hubProject] });
    renderSync(ACCOUNT, []);
    expect(await screen.findByText("Dịch vụ thanh toán.")).toBeTruthy();
    expect(await screen.findByText("Hoàn tiền đi qua bảng refunds.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Gửi lên hub" })).toBeNull();
  });

  it("dự án chưa có brief thì báo chưa có", async () => {
    fakeHub({ "briefs/get": null, "memory/list": [], "projects/list": [hubProject] });
    renderSync(ACCOUNT, []);
    expect(await screen.findByText("Dự án chưa có brief.")).toBeTruthy();
    expect(await screen.findByText("Chưa có memory.")).toBeTruthy();
  });

  it("Gửi lên hub ghi memory với source machine vào dự án", async () => {
    const calls = fakeHub({
      "briefs/get": null,
      "memory/list": [],
      "projects/list": [hubProject],
      "memory/write": { ...approved, status: "pending" },
    });
    renderSync(ACCOUNT);
    const user = userEvent.setup();
    const send = await screen.findByRole("button", { name: "Gửi lên hub" });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    await user.click(send);
    expect(await screen.findByText("Đã gửi, đang chờ người trong đội duyệt.")).toBeTruthy();
    expect(calls.find((c) => c.path === "memory/write")?.body).toEqual({
      scope: { level: "project", projectId: PROJECT_ID },
      kind: "note",
      content: "Dùng pnpm.",
      source: "machine",
    });
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });

  it("file dài quá giới hạn thì không cho gửi", async () => {
    fakeHub({ "briefs/get": null, "memory/list": [], "projects/list": [hubProject] });
    renderSync(ACCOUNT, [{ id: "big.md", label: "big.md", content: "x".repeat(2001) }]);
    const row = (await screen.findByText("big.md")).closest("li") as HTMLElement;
    expect(within(row).getByText(/Dài quá 2000 ký tự/)).toBeTruthy();
    expect((within(row).getByRole("button", { name: "Gửi lên hub" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("dự án chưa có trên hub thì báo và không cho gửi", async () => {
    fakeHub({ "briefs/get": null, "memory/list": [], "projects/list": [] });
    renderSync(ACCOUNT);
    expect(await screen.findByText("Dự án này chưa có trên hub, nên chưa gửi được.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Gửi lên hub" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
