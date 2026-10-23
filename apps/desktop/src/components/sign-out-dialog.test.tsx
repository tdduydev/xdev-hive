import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignOutDialog } from "@/components/sign-out-dialog.tsx";
import { setLang } from "@/lib/i18n.ts";
import type { LocalProject } from "@/lib/local-projects.ts";

const UNLINKED = { hub: "https://hive.acme.vn", linked: false, account: null, error: null };

const local = (localId: string, name: string, projectId: string): LocalProject => ({
  localId,
  projectId,
  name,
  folder: `/home/dev/${name}`,
  fullPermission: false,
  exists: true,
  isGit: true,
});

const secretOn = (name: string, ids: string[]) => ({
  name,
  description: "",
  createdAt: "2026-10-01T08:30:00Z",
  valueChangedAt: "2026-10-01T08:30:00Z",
  projects: ids.map((localId) => ({ localId, name: localId, folder: "" })),
  inUseBy: 0,
});

const list = (...secrets: ReturnType<typeof secretOn>[]) => ({ secrets, reserved: { exact: [], prefixes: [] } });

function fakeApp(over: Record<string, () => unknown> = {}) {
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  const handlers: Record<string, () => unknown> = {
    account_unlink: () => UNLINKED,
    local_projects: () => ({
      path: "",
      exists: true,
      imported: 0,
      // "c" chưa gắn dự án hub nên không phải dự án của tổ chức.
      projects: [local("a", "app", "p1"), local("b", "api", "p2"), local("c", "scratch", "")],
    }),
    secrets_list: () => list(secretOn("DATABASE_URL", ["a", "c"]), secretOn("STRIPE_TEST_KEY", ["a", "b"])),
    secrets_purge: () => ({ removed: [], left: [] }),
    ...over,
  };
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const h = handlers[command];
        if (!h) throw new Error(`lệnh chưa giả: ${command}`);
        return (await h()) as T;
      },
    },
  };
  return calls;
}

beforeEach(() => setLang("vi"));

function open(orgName: string | null = "Acme") {
  const onSignedOut = vi.fn();
  render(<SignOutDialog open onOpenChange={() => {}} onSignedOut={onSignedOut} orgName={orgName ?? undefined} />);
  return onSignedOut;
}

describe("đăng xuất và gán bí mật", () => {
  it("hỏi gỡ gán cho dự án của tổ chức, mặc định không chọn; đăng xuất không gọi purge", async () => {
    const calls = fakeApp();
    const user = userEvent.setup();
    const onSignedOut = open();
    const dialog = await screen.findByRole("dialog");
    const box = (await within(dialog).findByRole("checkbox", {
      name: /Gỡ luôn bí mật đã gán cho 2 dự án của tổ chức Acme/,
    })) as HTMLInputElement;
    expect(box.checked).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Đăng xuất" }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledWith(UNLINKED));
    expect(calls.some((c) => c.command === "secrets_purge")).toBe(false);
    expect(calls.some((c) => c.command === "account_unlink")).toBe(true);
  });

  it("chọn gỡ gán: gỡ từng dự án của tổ chức rồi mới gỡ token; dự án chưa gắn hub không đụng tới", async () => {
    const calls = fakeApp();
    const user = userEvent.setup();
    const onSignedOut = open();
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Đăng xuất" }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());

    const purges = calls.filter((c) => c.command === "secrets_purge");
    expect(purges.map((c) => c.args)).toEqual([{ project: "a" }, { project: "b" }]);
    const order = calls.map((c) => c.command);
    expect(order.lastIndexOf("secrets_purge")).toBeLessThan(order.indexOf("account_unlink"));
  });

  it("gỡ gán lỗi: báo lỗi, chưa gỡ token để thử lại", async () => {
    const calls = fakeApp({
      secrets_purge: () => {
        throw new Error("Không ghi được danh mục bí mật.");
      },
    });
    const user = userEvent.setup();
    const onSignedOut = open();
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Đăng xuất" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Không ghi được danh mục bí mật.");
    expect(calls.some((c) => c.command === "account_unlink")).toBe(false);
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("bí mật chỉ gán cho dự án chưa gắn hub: không có ô chọn", async () => {
    const calls = fakeApp({ secrets_list: () => list(secretOn("X_KEY", ["c"])) });
    open();
    await screen.findByRole("dialog");
    // Chờ lượt đọc xong rồi mới khẳng định không có ô chọn.
    await waitFor(() => expect(calls.some((c) => c.command === "secrets_list")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("worker cũ chưa có lệnh bí mật: không có ô chọn, vẫn đăng xuất được", async () => {
    const calls = fakeApp({
      secrets_list: () => {
        throw new Error("worker cũ");
      },
    });
    const user = userEvent.setup();
    const onSignedOut = open();
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(calls.some((c) => c.command === "secrets_list")).toBe(true));
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Đăng xuất" }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
  });

  it("không có tên tổ chức (token hỏng): không đọc bí mật, không có ô chọn", async () => {
    const calls = fakeApp();
    open(null);
    await screen.findByRole("dialog");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(calls.some((c) => c.command === "secrets_list")).toBe(false);
  });
});
