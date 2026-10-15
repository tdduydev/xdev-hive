import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitGroupsSection } from "@/components/git-groups.tsx";
import { type Account, AccountContext } from "@/lib/account.ts";
import type { GitGroup, GitGroups, GitHost, RepoStatus, SyncEvent } from "@/lib/git-groups.ts";
import { setLang } from "@/lib/i18n.ts";

const HOST: GitHost = {
  id: "0a1b2c3d4e5f",
  kind: "gitlab",
  url: "https://git.acme.vn",
  name: "GitLab Acme",
  username: "ha",
};
const repo = (path: string, over: Partial<GitGroup["repos"][number]> = {}) => ({
  path,
  name: path.split("/").at(-1) ?? path,
  defaultBranch: "main",
  httpUrl: `https://git.acme.vn/${path}.git`,
  ...over,
});
const GROUP: GitGroup = {
  id: "aaaaaaaaaaaa",
  hostId: HOST.id,
  path: "acme",
  root: "/Users/ha/Code",
  protocol: "https",
  repos: [repo("acme/api"), repo("acme/web"), repo("acme/docs"), repo("acme/old", { archived: true })],
};
const STATUS: RepoStatus[] = [
  { path: "acme/api", dir: "/Users/ha/Code/acme/api", state: "behind", branch: "main", behind: 2 },
  {
    path: "acme/web",
    dir: "/Users/ha/Code/acme/web",
    state: "dirty",
    branch: "main",
    reason: "có thay đổi chưa commit",
  },
  { path: "acme/docs", dir: "/Users/ha/Code/acme/docs", state: "missing" },
];

interface Call {
  command: string;
  args?: Record<string, unknown> | undefined;
}

// Tiến độ gom theo id ở cấp module (lib/git-groups.ts): mỗi ca một id để ca trước không lẫn vào.
let seq = 0;

/** Tauri giả: sidecar gitgroups giữ cấu hình trong bộ nhớ; `emit` phát sự kiện như Rust. */
function fakeApp(opts: {
  hosts?: GitHost[];
  groups?: GitGroup[];
  hub?: Record<string, unknown>;
  gitUser?: string;
  gitFailure?: string;
  discovered?: { kind: "gitlab" | "github"; url: string }[];
}) {
  const calls: Call[] = [];
  const job = `git-${++seq}`;
  let hosts = [...(opts.hosts ?? [])];
  let groups = [...(opts.groups ?? [])];
  const view = (extra: Partial<GitGroups> = {}): GitGroups => ({ path: "/x/gitgroups.json", hosts, groups, ...extra });
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    git_groups: () => view(),
    git_host_probe: (a) => {
      if (opts.gitFailure) throw opts.gitFailure;
      if (!opts.gitUser || (a?.url && a.url !== "https://git.test"))
        throw "Không tìm thấy đăng nhập Git cho máy chủ này.";
      return { username: opts.gitUser };
    },
    git_host_discover: () => opts.discovered ?? [],
    git_host_add: (a) => {
      if (a?.authMode !== "git" && a?.token !== "glpat-ok") throw "Token không dùng được với https://gitlab.com (401)";
      const h: GitHost = {
        id: "bbbbbbbbbbbb",
        kind: a.kind as "gitlab",
        url: String(a.url) || "https://gitlab.com",
        name: String(a.name) || "gitlab.com",
        username: opts.gitUser ?? "ha",
        authMode: a.authMode as "git" | "token",
      };
      hosts = [...hosts, h];
      return view({ host: h });
    },
    git_host_remove: (a) => {
      if (groups.some((g) => g.hostId === a?.id)) throw "kết nối đang được nhóm acme dùng; xoá nhóm trước";
      hosts = hosts.filter((h) => h.id !== a?.id);
      return view();
    },
    git_group_status: () => view({ status: STATUS }),
    git_group_sync: () => job,
    git_group_cancel: () => undefined,
    git_group_update: (a) => {
      groups = groups.map((g) => (g.id === a?.id ? { ...g, ...(a?.patch as object) } : g));
      return view();
    },
    open_folder: () => undefined,
    hub_rpc: (a) => {
      const path =
        String(a?.path)
          .replace(/^\/rpc\//, "")
          .split("?")[0] ?? "";
      const body = opts.hub?.[path];
      return {
        status: body === undefined ? 404 : 200,
        contentType: "application/json",
        body: JSON.stringify(
          body === undefined
            ? { json: { defined: false, code: "NOT_FOUND", status: 404, message: "x" } }
            : { json: body },
        ),
      };
    },
  };
  const listeners = new Map<string, ((e: { payload: unknown }) => void)[]>();
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const h = handlers[command];
        if (!h) throw new Error(`lệnh chưa giả: ${command}`);
        return (await h(args)) as T;
      },
    },
    event: {
      listen: async <T,>(name: string, handler: (e: { payload: T }) => void) => {
        const list = listeners.get(name) ?? [];
        list.push(handler as (e: { payload: unknown }) => void);
        listeners.set(name, list);
        return () => {};
      },
    },
  };
  const emit = (event: SyncEvent, jobId = job) =>
    act(() => {
      for (const l of listeners.get("git-groups:event") ?? []) l({ payload: { jobId, event } });
    });
  return { calls, emit, job };
}

function renderSection(onCloned = vi.fn(), account: Account | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AccountContext.Provider value={account}>
        <GitGroupsSection onCloned={onCloned} />
      </AccountContext.Provider>
    </QueryClientProvider>,
  );
  return onCloned;
}

describe("GitGroupsSection", () => {
  beforeEach(() => setLang("vi"));

  it("thêm kết nối không cần đăng nhập Hive; token sai báo lỗi và không lưu", async () => {
    const { calls } = fakeApp({});
    renderSection();
    expect(await screen.findByText(/Chưa có kết nối Git/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Thêm nhóm" })).toHaveProperty("disabled", true);

    await userEvent.click(screen.getByRole("button", { name: "Thêm kết nối" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Personal access token"), "sai");
    await userEvent.click(within(dialog).getByRole("button", { name: "Lưu" }));
    expect(await within(dialog).findByText(/Token không dùng được/)).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>("Personal access token").value).toBe("");

    await userEvent.type(within(dialog).getByLabelText("Personal access token"), "glpat-ok");
    await userEvent.click(within(dialog).getByRole("button", { name: "Lưu" }));
    expect(await screen.findByText("gitlab.com")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    const add = calls.filter((c) => c.command === "git_host_add");
    expect(add.at(-1)?.args).toEqual({ kind: "gitlab", url: "", name: "", token: "glpat-ok", authMode: "token" });
    expect(calls.some((c) => c.command === "hub_rpc")).toBe(false);
  });

  it("mặc định dùng đăng nhập Git đã kiểm tra, hiển thị tài khoản và không gửi token", async () => {
    const { calls } = fakeApp({ gitUser: "duy" });
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Thêm kết nối" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Tài khoản Git: duy")).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLSelectElement>("Cách đăng nhập").value).toBe("git");
    expect(within(dialog).queryByLabelText("Personal access token")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.command === "git_host_add")?.args).toEqual({
      kind: "gitlab",
      url: "",
      name: "",
      token: "",
      authMode: "git",
    });
  });

  it("cho phép chuyển sang PAT và không dùng tài khoản dò của máy chủ cũ", async () => {
    fakeApp({ gitUser: "duy" });
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Thêm kết nối" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Tài khoản Git: duy");
    await userEvent.selectOptions(within(dialog).getByLabelText("Cách đăng nhập"), "token");
    expect(within(dialog).getByLabelText("Personal access token")).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText("Địa chỉ máy chủ"), "https://other.test");
    expect(within(dialog).queryByText("Tài khoản Git: duy")).toBeNull();
    await userEvent.selectOptions(within(dialog).getByLabelText("Cách đăng nhập"), "git");
    expect(await within(dialog).findByText(/Không tìm thấy đăng nhập Git/)).toBeTruthy();
  });

  it("thêm kết nối một chạm từ host được phát hiện trên máy", async () => {
    const { calls } = fakeApp({ gitUser: "duy", discovered: [{ kind: "gitlab", url: "https://git.test" }] });
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Thêm kết nối" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(await within(dialog).findByRole("button", { name: "https://git.test" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.command === "git_host_add")?.args).toEqual({
      kind: "gitlab",
      url: "https://git.test",
      name: "",
      token: "",
      authMode: "git",
    });
  });

  it("hiện lý do API từ chối mật khẩu thường và gợi ý quyền PAT", async () => {
    fakeApp({ gitFailure: "Đăng nhập Git không được API chấp nhận. Hãy tạo PAT có read_api và read_repository." });
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Thêm kết nối" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/API chấp nhận.*read_api/)).toBeTruthy();
    expect(within(dialog).getByLabelText("Personal access token")).toBeTruthy();
  });

  it("dò và thêm đăng nhập Git cho GitHub", async () => {
    const { calls } = fakeApp({ gitUser: "duy" });
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Thêm kết nối" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText("Loại"), "github");
    await waitFor(() =>
      expect(calls.some((c) => c.command === "git_host_probe" && c.args?.kind === "github")).toBe(true),
    );
    await within(dialog).findByText("Tài khoản Git: duy");
    await userEvent.click(within(dialog).getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.command === "git_host_add")?.args).toMatchObject({
      kind: "github",
      token: "",
      authMode: "git",
    });
  });

  it("đã đăng nhập: điền sẵn từ kết nối Git của tổ chức", async () => {
    fakeApp({
      hub: {
        "scmConnections/list": [
          {
            id: "0a0a0a0a-0000-4000-8000-0000000000c1",
            kind: "github",
            name: "GitHub Enterprise",
            baseUrl: "https://ghe.acme.vn/api/v3",
            defaultOwner: "acme",
            authMode: "token",
            appId: null,
            installationId: null,
            createdAt: "2026-10-13T00:00:00.000Z",
          },
        ],
      },
    });
    renderSection(vi.fn(), {
      name: "Hà",
      email: "ha@acme.vn",
      orgId: "o1",
      orgName: "Acme",
      orgRole: "member",
      teams: [],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Thêm kết nối" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(
      await within(dialog).findByLabelText("Dùng thông tin kết nối của tổ chức"),
      "0a0a0a0a-0000-4000-8000-0000000000c1",
    );
    expect(within(dialog).getByLabelText<HTMLSelectElement>("Loại").value).toBe("github");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Địa chỉ máy chủ").value).toBe("https://ghe.acme.vn");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Personal access token").value).toBe("");
  });

  it("hiện trạng thái, pull có tiến độ, huỷ, rồi báo tổng", async () => {
    const { calls, emit, job } = fakeApp({ hosts: [HOST], groups: [GROUP] });
    const onCloned = renderSection();
    const card = await screen.findByRole("article", { name: "acme" });
    expect(await within(card).findByText("Behind")).toBeTruthy();
    expect(within(card).getByText("Có thay đổi")).toBeTruthy();
    expect(within(card).getByText("Chưa clone")).toBeTruthy();
    expect(within(card).getByText(/3\/4 repo được chọn/)).toBeTruthy();
    expect(within(card).queryByText("acme/old")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Mở thư mục acme/docs" })).toBeNull();

    await userEvent.click(within(card).getByRole("button", { name: "Pull tất cả" }));
    expect(calls.find((c) => c.command === "git_group_sync")?.args).toEqual({
      id: GROUP.id,
      host: HOST.id,
      action: "pull",
    });
    emit({ type: "start", action: "pull", total: 3 });
    emit({
      type: "repo",
      action: "pull",
      total: 3,
      done: 1,
      path: "acme/web",
      result: "skipped",
      message: "có thay đổi chưa commit",
      status: STATUS[1],
    });
    expect(within(card).getByText("Đang pull 1/3 repo…")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Pull tất cả" })).toHaveProperty("disabled", true);
    expect(within(card).getByText("Bỏ qua")).toBeTruthy();

    await userEvent.click(within(card).getByRole("button", { name: "Huỷ" }));
    expect(calls.some((c) => c.command === "git_group_cancel" && c.args?.jobId === job)).toBe(true);
    emit({
      type: "repo",
      path: "acme/api",
      total: 3,
      done: 2,
      result: "done",
      status: { ...STATUS[0], state: "clean", behind: 0 } as RepoStatus,
    });
    emit({ type: "repo", path: "acme/docs", total: 3, done: 3, result: "cancelled" });
    emit({ type: "done", action: "pull", total: 3, done: 3, summary: { done: 1, skipped: 1, cancelled: 1 } });
    expect(within(card).getByText("Xong: 1 đã chạy, 0 không đổi, 1 bỏ qua, 0 lỗi, 1 đã huỷ.")).toBeTruthy();
    expect(within(card).getByText("Sạch")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Pull tất cả" })).toHaveProperty("disabled", false);
    expect(onCloned).not.toHaveBeenCalled();
  });

  it("clone xong thì danh sách Dự án trên máy đọc lại; sự kiện đến trước id vẫn được tính", async () => {
    const { emit } = fakeApp({ hosts: [HOST], groups: [GROUP] });
    const onCloned = renderSection();
    const card = await screen.findByRole("article", { name: "acme" });
    await within(card).findByText("Chưa clone");
    emit({ type: "start", action: "clone", total: 3 });
    await userEvent.click(within(card).getByRole("button", { name: "Clone thiếu" }));
    emit({
      type: "repo",
      path: "acme/docs",
      total: 3,
      done: 3,
      result: "done",
      status: { path: "acme/docs", dir: "/Users/ha/Code/acme/docs", state: "clean", branch: "main" },
    });
    emit({ type: "done", action: "clone", total: 3, done: 3, summary: { done: 1, unchanged: 2 } });
    expect(onCloned).toHaveBeenCalled();
    expect(within(card).getByRole("button", { name: "Mở thư mục acme/docs" })).toBeTruthy();
  });

  it("bỏ chọn repo và bật tự fetch qua cài đặt nhóm; xoá kết nối còn nhóm thì báo lỗi", async () => {
    const { calls } = fakeApp({ hosts: [HOST], groups: [GROUP] });
    renderSection();
    const card = await screen.findByRole("article", { name: "acme" });
    await userEvent.click(within(card).getByRole("button", { name: "Cài đặt nhóm" }));
    await userEvent.click(within(card).getByRole("checkbox", { name: "acme/web" }));
    expect(calls.find((c) => c.command === "git_group_update")?.args).toEqual({
      id: GROUP.id,
      patch: { excluded: ["acme/web"] },
    });
    expect(await within(card).findByText(/2\/4 repo được chọn/)).toBeTruthy();
    await userEvent.selectOptions(within(card).getByLabelText("Tự fetch"), "30");
    expect(calls.filter((c) => c.command === "git_group_update").at(-1)?.args).toEqual({
      id: GROUP.id,
      patch: { autoFetchMinutes: 30 },
    });
    expect(await within(card).findByText(/Tự fetch: Mỗi 30 phút/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Xoá kết nối GitLab Acme" }));
    expect(await screen.findByText(/đang được nhóm acme dùng/)).toBeTruthy();
  });
});
