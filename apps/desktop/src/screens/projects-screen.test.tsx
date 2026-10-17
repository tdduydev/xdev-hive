import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { type Account, AccountContext } from "@/lib/account.ts";
import type { GitGroups } from "@/lib/git-groups.ts";
import { setLang } from "@/lib/i18n.ts";
import type { LocalProject, LocalProjects } from "@/lib/local-projects.ts";
import { resetTerminals, terminals } from "@/lib/pty.ts";
import { ProjectsScreen } from "@/screens/projects-screen.tsx";

const ACCOUNT: Account = {
  name: "Phạm Hà",
  email: "ha@acme.vn",
  orgId: "o1",
  orgName: "Acme",
  orgRole: "member",
  teams: [{ id: "t1", name: "Thanh toán", role: "admin" }],
};
const at = "2026-10-13T00:00:00.000Z";
const P1 = "0a0a0a0a-0000-4000-8000-000000000001";
const P2 = "0a0a0a0a-0000-4000-8000-000000000002";

const project = (id: string, key: string, name: string, url: string) => ({
  id,
  systemId: "0a0a0a0a-0000-4000-8000-0000000000a1",
  teamId: "0a0a0a0a-0000-4000-8000-0000000000b1",
  key,
  name,
  state: "active",
  repo: {
    mode: "existing",
    connectionId: "0a0a0a0a-0000-4000-8000-0000000000c1",
    kind: "github",
    owner: "acme",
    name: key,
    defaultBranch: "main",
    visibility: "private",
    httpUrl: url,
    sshUrl: null,
    webUrl: url.replace(/\.git$/, ""),
  },
  settings: {},
  createdBy: "u1",
  createdAt: at,
  updatedAt: at,
});
const PAY = project(P1, "pay", "payment-api", "https://github.com/acme/payment-api.git");
const WEB = project(P2, "web", "web-shop", "https://github.com/acme/web-shop.git");

const entry = (over: Partial<LocalProject>): LocalProject => ({
  projectId: "",
  name: "app",
  folder: "/Users/ha/Work/app",
  fullPermission: false,
  exists: true,
  isGit: true,
  ...over,
});

interface Call {
  command: string;
  args?: Record<string, unknown> | undefined;
}

/**
 * Tauri giả: hub sau hub_rpc theo thủ tục RPC, sidecar `hive-worker projects` giữ danh sách trong bộ nhớ như worker.
 */
function fakeApp(opts: {
  hub: Record<string, unknown>;
  local: LocalProject[];
  exists?: boolean;
  legacy?: LocalProject[];
  picked?: string;
  gitGroups?: Pick<GitGroups, "hosts" | "groups">;
}) {
  const calls: Call[] = [];
  let list = [...opts.local];
  let exists = opts.exists ?? true;
  const view = (imported = 0): LocalProjects => ({ path: "/x/projects.json", exists, imported, projects: list });
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    local_projects: () => view(),
    local_projects_import: () => {
      exists = true;
      list = [...list, ...(opts.legacy ?? [])];
      return view(opts.legacy?.length ?? 0);
    },
    local_project_bind: (a) => {
      const id = String(a?.id);
      const folder = String(a?.folder);
      const old = list.find((l) => l.projectId === id);
      list = [
        ...list.filter((l) => l.projectId !== id && !(l.projectId === "" && l.folder === folder)),
        entry({
          projectId: id,
          name: String(a?.name),
          folder,
          fullPermission: old?.fullPermission ?? false,
          origin: (a?.repoUrl as string | null) ?? list.find((l) => l.folder === folder)?.origin,
        }),
      ];
      return view();
    },
    local_project_unbind: (a) => {
      list = list.filter((l) => (a?.id ? l.projectId !== a.id : l.folder !== a?.folder));
      return view();
    },
    local_project_set_full: (a) => {
      list = list.map((l) => (l.projectId === a?.id ? { ...l, fullPermission: Boolean(a?.full) } : l));
      return view();
    },
    "plugin:dialog|open": () => opts.picked ?? null,
    git_groups: () => ({ path: "/x/gitgroups.json", hosts: [], groups: [], ...opts.gitGroups }),
    git_group_status: () => ({ path: "/x/gitgroups.json", hosts: [], groups: [], ...opts.gitGroups, status: [] }),
    hub_rpc: (a) => {
      const path =
        String(a?.path)
          .replace(/^\/rpc\//, "")
          .split("?")[0] ?? "";
      const body = opts.hub[path];
      return {
        status: body === undefined ? 404 : 200,
        contentType: "application/json",
        body: JSON.stringify(
          body === undefined
            ? { json: { defined: false, code: "NOT_FOUND", status: 404, message: "x" } }
            : { json: typeof body === "function" ? body(a?.body ? JSON.parse(String(a.body)).json : null) : body },
        ),
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
  return calls;
}

const policy = (allowFullPermission: boolean) => ({ allowFullPermission });

const renderScreen = (account: Account | null = ACCOUNT) =>
  render(
    <AccountContext.Provider value={account}>
      <ProjectsScreen />
    </AccountContext.Provider>,
  );

const row = async (name: string) => (await screen.findByText(name)).closest("li") as HTMLElement;

describe("ProjectsScreen", () => {
  beforeEach(() => {
    setLang("vi");
    location.hash = "#/projects";
  });

  it("lần đầu nhập repo của app cũ, tự gắn theo remote origin rồi theo tên, còn lại vào mục chưa có trên hub", async () => {
    const calls = fakeApp({
      hub: { "projects/list": [PAY, WEB], "policies/get": policy(true) },
      local: [],
      exists: false,
      legacy: [
        entry({ name: "thanh-toan", folder: "/w/pay", origin: "git@github.com:acme/payment-api.git" }),
        entry({ name: "web", folder: "/w/web", origin: undefined }),
        entry({ name: "cu", folder: "/w/cu", origin: "https://gitlab.com/acme/cu.git" }),
      ],
    });
    renderScreen();
    expect(await screen.findByText("Đã nhập 3 repo từ app cũ, tự gắn 2 dự án.")).toBeTruthy();
    const binds = calls.filter((c) => c.command === "local_project_bind").map((c) => [c.args?.id, c.args?.folder]);
    expect(binds).toEqual([
      [P1, "/w/pay"],
      [P2, "/w/web"],
    ]);
    expect(within(await row("payment-api")).getByText("Đã gắn")).toBeTruthy();
    // Gắn theo tên mà repo không có origin: hiện để người dùng sửa.
    expect(within(await row("web-shop")).getByText("Remote không khớp")).toBeTruthy();
    const waiting = screen.getByRole("region", { name: "Repo trên máy chưa có trên hub" });
    expect(within(waiting).getByText("cu")).toBeTruthy();
    // Tạo dự án trên hub là việc quản trị, chỉ làm ở web: app không có nút tạo.
    expect(within(waiting).queryByRole("button", { name: /Tạo dự án/ })).toBeNull();
    expect(screen.getByText(/Dự án mới tạo trên web của Hive/)).toBeTruthy();
  });

  it("chọn thư mục gắn dự án và gửi URL repo để worker kiểm origin; thư mục mất hiện rõ", async () => {
    const calls = fakeApp({
      hub: { "projects/list": [PAY, WEB], "policies/get": policy(true) },
      local: [entry({ projectId: P2, name: "web-shop", folder: "/w/web", exists: false })],
      picked: "/Users/ha/Work/payment-api",
    });
    renderScreen();
    expect(within(await row("web-shop")).getByText("Thư mục mất")).toBeTruthy();
    const pay = await row("payment-api");
    expect(within(pay).getByText("Chưa gắn")).toBeTruthy();
    await userEvent.setup().click(within(pay).getByRole("button", { name: "Chọn thư mục repo của payment-api" }));
    expect(await screen.findByText("Đã gắn payment-api.")).toBeTruthy();
    expect(calls.find((c) => c.command === "local_project_bind")?.args).toEqual({
      id: P1,
      folder: "/Users/ha/Work/payment-api",
      name: "payment-api",
      repoUrl: "https://github.com/acme/payment-api.git",
    });
    expect(within(await row("payment-api")).getByText("Đã gắn")).toBeTruthy();
  });

  it("nút Terminal mở màn Terminal ở thư mục của dự án; thư mục mất thì không có nút", async () => {
    resetTerminals();
    fakeApp({
      hub: { "projects/list": [PAY, WEB], "policies/get": policy(true) },
      local: [
        entry({ projectId: P1, name: "payment-api", folder: "/w/pay" }),
        entry({ projectId: P2, name: "web-shop", folder: "/w/web", exists: false }),
        entry({ name: "cu", folder: "/w/cu", origin: "https://gitlab.com/acme/cu.git" }),
      ],
    });
    const user = userEvent.setup();
    renderScreen();
    await user.click(within(await row("payment-api")).getByRole("button", { name: "Mở terminal ở payment-api" }));
    expect(location.hash).toBe("#/terminal");
    expect(terminals().folder).toBe("/w/pay");
    expect(terminals().sessions.map((s) => s.folder)).toEqual(["/w/pay"]);
    expect(within(await row("web-shop")).queryByRole("button", { name: /Mở terminal/ })).toBeNull();
    const waiting = screen.getByRole("region", { name: "Repo trên máy chưa có trên hub" });
    await user.click(within(waiting).getByRole("button", { name: "Mở terminal ở cu" }));
    expect(terminals().folder).toBe("/w/cu");
  });

  it("bật toàn quyền phải xác nhận rủi ro; tắt thì không hỏi", async () => {
    const calls = fakeApp({
      hub: { "projects/list": [PAY], "policies/get": policy(true) },
      local: [entry({ projectId: P1, name: "payment-api", folder: "/w/pay", origin: PAY.repo.httpUrl })],
    });
    renderScreen();
    const user = userEvent.setup();
    const toggle = await screen.findByRole("switch", { name: "Cho toàn quyền trên máy này với payment-api" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // Công tắc khoá tới khi chính sách tổ chức và danh sách trên máy tải xong.
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    await user.click(toggle);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Antigravity: --dangerously-skip-permissions")).toBeTruthy();
    expect(within(dialog).getByText(/không sandbox và không hỏi duyệt/)).toBeTruthy();
    // Huỷ thì không ghi gì.
    await user.click(within(dialog).getByRole("button", { name: "Huỷ" }));
    expect(calls.some((c) => c.command === "local_project_set_full")).toBe(false);
    await user.click(toggle);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Bật toàn quyền" }));
    expect(await screen.findByText("Đã cho toàn quyền với payment-api trên máy này.")).toBeTruthy();
    expect(calls.find((c) => c.command === "local_project_set_full")?.args).toEqual({ id: P1, full: true });
    const on = screen.getByRole("switch", { name: "Cho toàn quyền trên máy này với payment-api" });
    await waitFor(() => expect(on.getAttribute("aria-checked")).toBe("true"));
    await waitFor(() => expect((on as HTMLButtonElement).disabled).toBe(false));
    await user.click(on);
    expect(await screen.findByText("Đã tắt toàn quyền với payment-api.")).toBeTruthy();
    expect(calls.filter((c) => c.command === "local_project_set_full").at(-1)?.args).toEqual({ id: P1, full: false });
  });

  it("tổ chức cấm toàn quyền: công tắc tắt, khoá và nêu lý do; dự án chưa gắn cũng khoá", async () => {
    fakeApp({
      hub: { "projects/list": [PAY, WEB], "policies/get": policy(false) },
      local: [entry({ projectId: P1, name: "payment-api", folder: "/w/pay", fullPermission: true })],
    });
    renderScreen();
    const toggle = await screen.findByRole("switch", { name: "Cho toàn quyền trên máy này với payment-api" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(await within(await row("payment-api")).findByText(/Tổ chức không cho toàn quyền CLI/)).toBeTruthy();
    const web = screen.getByRole("switch", { name: "Cho toàn quyền trên máy này với web-shop" });
    expect((web as HTMLButtonElement).disabled).toBe(true);
  });

  it("repo chưa có trên hub gom theo namespace: thu gọn, đếm repo, mở từng nhóm, lọc", async () => {
    fakeApp({
      hub: { "projects/list": [], "policies/get": policy(true) },
      local: [
        entry({ name: "his-web", folder: "/w/his-web", origin: "git@gitlab.fis.vn:EHospital-AI/HIS/his-web.git" }),
        entry({
          name: "his-admin",
          folder: "/w/his-admin",
          origin: "https://gitlab.fis.vn/EHospital-AI/HIS/his-admin.git",
        }),
        entry({
          name: "emr-core",
          folder: "/w/emr-core",
          origin: "https://gitlab.fis.vn/ehospital-ai/emr/emr-core.git",
        }),
        entry({ name: "nhap", folder: "/w/tmp/nhap" }),
      ],
      gitGroups: {
        hosts: [{ id: "h1", kind: "gitlab", url: "https://gitlab.fis.vn", name: "GitLab FIS" }],
        groups: [
          {
            id: "g1",
            hostId: "h1",
            path: "ehospital-ai",
            root: "/w",
            protocol: "https",
            repos: [
              {
                path: "ehospital-ai/his/his-web",
                name: "his-web",
                httpUrl: "https://gitlab.fis.vn/ehospital-ai/his/his-web.git",
              },
            ],
          },
        ],
      },
    });
    renderScreen();
    const user = userEvent.setup();
    const waiting = screen.getByRole("region", { name: "Repo trên máy chưa có trên hub" });
    // Nhiều nhóm thì thu gọn; tên nhóm lấy theo Nhóm Git theo dõi, máy chủ hiện tên kết nối.
    const his = await within(waiting).findByRole("button", { name: "ehospital-ai/his · GitLab FIS 2 repo" });
    expect(
      within(waiting)
        .getAllByRole("button", { expanded: false })
        .map((b) => b.textContent),
    ).toEqual(["ehospital-ai/emr · GitLab FIS 1 repo", "ehospital-ai/his · GitLab FIS 2 repo", "/w/tmp 1 repo"]);
    expect(within(waiting).queryByText("his-web")).toBeNull();
    await user.click(his);
    expect(his.getAttribute("aria-expanded")).toBe("true");
    // Nút của từng repo giữ nguyên.
    expect(within(waiting).getByRole("button", { name: "Bỏ his-web khỏi danh sách" })).toBeTruthy();
    expect(within(waiting).getByText("origin: git@gitlab.fis.vn:EHospital-AI/HIS/his-web.git")).toBeTruthy();
    await user.click(his);
    expect(within(waiting).queryByText("his-web")).toBeNull();
    // Đang lọc thì mở sẵn các nhóm còn lại.
    const filter = within(waiting).getByRole("textbox", { name: "Lọc repo trên máy" });
    await user.type(filter, "core");
    expect(within(waiting).queryByRole("button", { name: /^ehospital-ai\/his/ })).toBeNull();
    expect(
      within(waiting)
        .getByRole("button", { name: /^ehospital-ai\/emr/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(within(waiting).getByText("emr-core")).toBeTruthy();
    await user.clear(filter);
    await user.type(filter, "khong-co");
    expect(within(waiting).getByText("Không có repo nào khớp.")).toBeTruthy();
  });

  it("bỏ repo khi đang lọc mà danh sách còn một repo thì vẫn giữ ô lọc để xoá chữ", async () => {
    fakeApp({
      hub: { "projects/list": [], "policies/get": policy(true) },
      local: [entry({ name: "cu", folder: "/w/cu" }), entry({ name: "moi", folder: "/w/moi" })],
    });
    renderScreen();
    const user = userEvent.setup();
    const waiting = screen.getByRole("region", { name: "Repo trên máy chưa có trên hub" });
    await user.type(await within(waiting).findByRole("textbox", { name: "Lọc repo trên máy" }), "cu");
    await user.click(within(waiting).getByRole("button", { name: "Bỏ cu khỏi danh sách" }));
    expect(await within(waiting).findByText("Không có repo nào khớp.")).toBeTruthy();
    await user.clear(within(waiting).getByRole("textbox", { name: "Lọc repo trên máy" }));
    expect(within(waiting).getByText("moi")).toBeTruthy();
  });

  it("chưa liên kết tài khoản thì không gọi hub, vẫn hiện repo trên máy", async () => {
    const calls = fakeApp({ hub: {}, local: [entry({ name: "cu", folder: "/w/cu" })] });
    renderScreen(null);
    expect(await screen.findByText(/Kết nối Hive để xem và gắn dự án/)).toBeTruthy();
    expect(await screen.findByText("cu")).toBeTruthy();
    expect(calls.some((c) => c.command === "hub_rpc")).toBe(false);
  });
});
