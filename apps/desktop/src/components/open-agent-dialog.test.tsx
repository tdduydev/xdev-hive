import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FOLDER, fakeTauri, type Handler, status } from "@/components/branch-test-helpers.ts";
import { OpenAgentButton, pullTarget } from "@/components/open-agent-dialog.tsx";
import type { BranchEvent, BranchStatus } from "@/lib/git-branches.ts";
import { setLang } from "@/lib/i18n.ts";
import { rememberTermDefault } from "@/lib/term-defaults.ts";

const plan = (id: string, cli: string, extra: { enabled?: boolean; loggedIn?: boolean; priority?: number } = {}) => ({
  id,
  label: id,
  cli,
  enabled: true,
  priority: 1,
  maxConcurrent: 1,
  cooldownMinutes: 0,
  supported: true,
  loggedIn: true,
  ...extra,
});

const ACCOUNTS = [
  plan("claude-2", "claude", { priority: 10 }),
  plan("claude-3", "claude", { priority: 50, enabled: false }),
  plan("claude-4", "claude", { priority: 90, loggedIn: false }),
  plan("codex-1", "codex"),
];

// Tiến độ pull gom theo id ở cấp module (lib/git-branches.ts): mỗi ca một id để ca trước không lẫn vào.
let seq = 0;

/** Tauri giả có sự kiện: `pull` trả id job, test phát sự kiện `done` như Rust. */
function fakeApp(extra: Record<string, Handler> = {}) {
  const listeners: ((e: { payload: unknown }) => void)[] = [];
  const ids = { pull: "" };
  const app = fakeTauri({
    cli_profiles: () => ({ path: "/Users/ha/.xdev-hive/accounts.json", accounts: ACCOUNTS }),
    git_branches_pull: () => {
      ids.pull = `pull-${++seq}`;
      return ids.pull;
    },
    open_agent_terminal: () => null,
    ...extra,
  });
  const event = window.__TAURI__?.event;
  if (event)
    event.listen = (async (_name: string, handler: (e: { payload: unknown }) => void) => {
      listeners.push(handler);
      return () => {};
    }) as typeof event.listen;
  const emit = (jobId: string, e: BranchEvent) =>
    act(() => {
      for (const l of listeners) l({ payload: { jobId, event: e } });
    });
  return { ...app, ids, emit };
}

const onFeature = status({ branch: "feature", upstream: "origin/feature" });

function renderButton(branch: BranchStatus | undefined, onPulled = () => {}) {
  render(<OpenAgentButton name="shop" folder={FOLDER} branch={branch} onPulled={onPulled} />);
}

describe("OpenAgentButton", () => {
  beforeEach(() => {
    setLang("vi");
    localStorage.clear();
    location.hash = "";
  });

  it("chỉ cho chọn gói đã đăng nhập, đang bật; pull xong mới mở terminal của máy bỏ hỏi quyền", async () => {
    const app = fakeApp();
    const onPulled = vi.fn();
    const user = userEvent.setup();
    renderButton(onFeature, onPulled);
    await user.click(screen.getByRole("button", { name: /Pull rồi mở shop bằng agent/ }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("option", { name: "claude-2" });
    const picker = within(dialog).getByRole("combobox", { name: "Gói agent" }) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("claude-2"));
    expect([...picker.options].map((o) => o.value)).toEqual(["", "claude-2"]);
    expect(within(dialog).getByText("Pull feature từ origin/feature trước khi mở.")).toBeTruthy();
    expect(within(dialog).getByText(/--dangerously-skip-permissions/)).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Pull rồi mở không hỏi quyền" }));
    await waitFor(() => expect(app.named("git_branches_pull")).toEqual([{ folder: FOLDER, confirmBusy: false }]));
    expect(app.named("open_agent_terminal")).toEqual([]);

    await app.emit(app.ids.pull, { type: "done", folder: FOLDER, pull: { state: "done", behind: 3 } });
    await waitFor(() =>
      expect(app.named("open_agent_terminal")).toEqual([
        { cli: "claude", planId: "claude-2", bypass: true, folder: FOLDER },
      ]),
    );
    expect(onPulled).toHaveBeenCalledOnce();
    expect(location.hash).toBe("");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(JSON.stringify(localStorage)).not.toContain("bypass");
  });

  it("pull lỗi thì không mở terminal", async () => {
    const app = fakeApp();
    const user = userEvent.setup();
    renderButton(onFeature);
    await user.click(screen.getByRole("button", { name: /Pull rồi mở shop bằng agent/ }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Pull rồi mở không hỏi quyền" }),
    );
    await waitFor(() => expect(app.ids.pull).not.toBe(""));
    await app.emit(app.ids.pull, { type: "done", folder: FOLDER, error: { code: "dirty", message: "lỗi dirty" } });
    await screen.findByText(/lỗi dirty|thay đổi/);
    expect(app.named("open_agent_terminal")).toEqual([]);
  });

  it("nhánh không theo dõi remote thì mở luôn, không pull; đổi CLI chọn sẵn gói của CLI đó", async () => {
    const app = fakeApp();
    const user = userEvent.setup();
    rememberTermDefault(FOLDER, { cli: "codex", planId: "codex-1" });
    renderButton(status({ branch: "local-only" }));
    await user.click(screen.getByRole("button", { name: /Pull rồi mở shop bằng agent/ }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("option", { name: "codex-1" });
    await waitFor(() =>
      expect((within(dialog).getByRole("combobox", { name: "Chạy" }) as HTMLSelectElement).value).toBe("codex"),
    );
    expect(within(dialog).getByText("Không pull: nhánh chưa theo dõi nhánh remote nào.")).toBeTruthy();
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Chạy" }), "claude");
    expect((within(dialog).getByRole("combobox", { name: "Gói agent" }) as HTMLSelectElement).value).toBe("claude-2");

    await user.click(within(dialog).getByRole("button", { name: "Mở không hỏi quyền" }));
    expect(app.named("git_branches_pull")).toEqual([]);
    await waitFor(() =>
      expect(app.named("open_agent_terminal")).toEqual([
        { cli: "claude", planId: "claude-2", bypass: true, folder: FOLDER },
      ]),
    );
  });

  it("không mở được terminal thì giữ hộp thoại và hiện lỗi", async () => {
    fakeApp({
      open_agent_terminal: () => {
        throw "Không tìm thấy ứng dụng terminal.";
      },
    });
    const user = userEvent.setup();
    renderButton(status({ branch: "local-only" }));
    await user.click(screen.getByRole("button", { name: /Pull rồi mở shop bằng agent/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Mở không hỏi quyền" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Không tìm thấy ứng dụng terminal.");
  });
});

describe("pullTarget", () => {
  it("pull nhánh đang đứng khi có upstream, không thì nói vì sao", () => {
    expect(pullTarget(onFeature)).toEqual({ branch: "feature", upstream: "origin/feature" });
    expect(pullTarget(undefined)).toBe("unknown");
    expect(pullTarget(status({ detached: true, branch: undefined }))).toBe("detached");
    expect(pullTarget(status({ upstream: "origin/x", upstreamGone: true }))).toBe("gone");
    expect(pullTarget(status({ upstream: "origin/x", operation: "rebase" }))).toBe("operation");
    expect(pullTarget(status())).toBe("noUpstream");
  });
});
