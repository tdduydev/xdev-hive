import { render, waitFor } from "@testing-library/react";
import type { InboxItem } from "@xdev-hive/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import type { MachineRun } from "@/lib/machine-runs.ts";
import type { AppSettings } from "@/lib/settings.ts";
import { finishedRuns, freshInbox, hubPath, inboxNotice, useTeamNotifications } from "@/lib/team-notify.ts";

const item = (over: Partial<InboxItem>): InboxItem => ({
  id: "00000000-0000-4000-8000-000000000001",
  event: "plan.awaiting_approval",
  title: "Kế hoạch của PAY-142 chờ duyệt",
  body: "Hoàn tiền một phần cho đơn đã giao\nNgười giao việc: Lan",
  link: "https://hive.acme.vn/tasks/PAY-142",
  createdAt: new Date().toISOString(),
  readAt: null,
  ...over,
});

const run = (id: string, state: string): MachineRun => ({
  id,
  kind: "code",
  state,
  taskKey: `PAY-${id}`,
  title: `Việc ${id}`,
  projectId: "p",
  project: null,
  cli: "claude",
  model: null,
  machine: "dev-ha",
  costUsd: null,
  tokensIn: 0,
  prUrl: null,
  createdAt: new Date().toISOString(),
  startedAt: null,
  finishedAt: null,
});

describe("đích của thông báo", () => {
  it("chỉ giữ đường dẫn trên hub, liên kết lạ về trang chung", () => {
    expect(hubPath("https://hive.acme.vn/knowledge/reviews?tab=code&id=ab-12", "/x")).toBe(
      "/knowledge/reviews?tab=code&id=ab-12",
    );
    expect(hubPath("https://public.acme.vn/sdlc/PAY/012", "/x")).toBe("/sdlc/PAY/012");
    expect(hubPath(null, "/knowledge/reviews")).toBe("/knowledge/reviews");
    expect(hubPath("https://hive.acme.vn/a b#<x>", "/x")).toBe("/x");
  });

  it("kế hoạch, PR, tài liệu chờ duyệt và câu hỏi thì báo; sự kiện khác của hộp thư thì không", () => {
    expect(inboxNotice(item({}))).toEqual({
      title: "Kế hoạch của PAY-142 chờ duyệt",
      body: "Hoàn tiền một phần cho đơn đã giao",
      web: "/tasks/PAY-142",
    });
    expect(inboxNotice(item({ event: "sdlc.question", link: null }))?.web).toBe("/sdlc/questions");
    expect(inboxNotice(item({ event: "code_review.awaiting", link: null }))?.web).toBe("/knowledge/reviews");
    expect(inboxNotice(item({ event: "docsync.sync_failed" }))).toBeNull();
    expect(inboxNotice(item({ body: "## Kế hoạch\n\n- Bước một" }))?.body).toBe("Kế hoạch");
  });
});

describe("mục mới", () => {
  it("lần dò đầu chỉ ghi nhớ, lần sau báo mục chưa thấy", () => {
    const a = item({ id: "a" });
    const b = item({ id: "b" });
    const first = freshInbox([a], null);
    expect(first).toEqual({ fresh: [], seen: ["a"] });
    const next = freshInbox([b, a], first.seen);
    expect(next.fresh.map((i) => i.id)).toEqual(["b"]);
    expect(next.seen).toEqual(["a", "b"]);
  });

  it("run vừa xong hay lỗi thì báo, run huỷ hay vẫn chạy thì không", () => {
    setLang("vi");
    const before = new Map([
      ["1", "running"],
      ["2", "verifying"],
      ["3", "running"],
      ["4", "running"],
      ["5", "succeeded"],
    ]);
    const notices = finishedRuns(before, [
      run("1", "succeeded"),
      run("2", "failed"),
      run("3", "cancelled"),
      run("4", "running"),
      run("5", "succeeded"),
      run("6", "failed"),
    ]);
    expect(notices).toEqual([
      { title: "PAY-1 đã xong trên máy này", body: "Việc 1", screen: "runs" },
      { title: "PAY-2 lỗi trên máy này", body: "Việc 2", screen: "runs" },
    ]);
  });
});

const ON: AppSettings = {
  startWorker: true,
  hideOnClose: true,
  notifyRuns: true,
  notifyApprovals: true,
  notifyQuestions: true,
  notifyOffline: true,
};

function Probe({ signedIn }: { signedIn: boolean }) {
  useTeamNotifications(signedIn);
  return null;
}

function fakeTauri(settings: AppSettings, items: InboxItem[]) {
  const shown: Record<string, unknown>[] = [];
  const calls: string[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push(command);
        if (command === "app_settings") return settings as T;
        if (command === "hub_rpc")
          return {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ json: { items, nextCursor: null } }),
          } as T;
        if (command === "this_machine") return null as T;
        if (command === "show_notification") {
          shown.push(args ?? {});
          return undefined as T;
        }
        throw new Error(`lệnh chưa giả: ${command}`);
      },
    },
  };
  return { shown, calls };
}

describe("useTeamNotifications", () => {
  beforeEach(() => {
    // Đã dò trước đó (hộp thư trống): mục đến lần này là mới.
    localStorage.setItem("hive.notify.inbox", "[]");
  });

  it("đã đăng nhập: báo kế hoạch chờ duyệt, bấm mở trang web của việc", async () => {
    const { shown } = fakeTauri(ON, [item({}), item({ id: "x", event: "docsync.import_done" })]);
    render(<Probe signedIn />);
    await waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]).toEqual({
      title: "Kế hoạch của PAY-142 chờ duyệt",
      body: "Hoàn tiền một phần cho đơn đã giao",
      web: "/tasks/PAY-142",
      screen: null,
    });
    expect(JSON.parse(localStorage.getItem("hive.notify.inbox") ?? "[]")).toEqual([item({}).id, "x"]);
  });

  it("tắt loại thông báo ở Cài đặt thì không báo, vẫn ghi nhớ để bật lại không báo dồn", async () => {
    const { shown, calls } = fakeTauri({ ...ON, notifyApprovals: false }, [item({})]);
    render(<Probe signedIn />);
    await waitFor(() => expect(calls).toContain("this_machine"));
    expect(shown).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem("hive.notify.inbox") ?? "[]")).toEqual([item({}).id]);
  });

  it("chưa đăng nhập thì không dò hub", async () => {
    const { calls } = fakeTauri(ON, [item({})]);
    render(<Probe signedIn={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });
});
