import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountContext } from "@/lib/account.ts";
import { setLang } from "@/lib/i18n.ts";
import {
  applyMemory,
  type MemoryFile,
  type MemoryInventory,
  type MemoryOperation,
  type MemoryResult,
  memoryTree,
  readMemory,
  scanMemory,
} from "@/lib/memory-store.ts";
import { NAV_ITEMS, navItems, screenFromHash } from "@/lib/nav.ts";
import { MemoryScreen } from "@/screens/memory-screen.tsx";

const file = (path: string, over: Partial<MemoryFile> = {}): MemoryFile => ({
  cli: "claude",
  profile: "claude-1",
  projectKey: "project",
  projectPath: "/repo/app",
  path,
  name: path.split("/").at(-1) ?? path,
  kind: "memory",
  size: 120,
  tokens: 30,
  modifiedAt: "2026-10-14T08:00:00Z",
  flags: [],
  ...over,
});
const A = file("/profiles/one/projects/project/memory/a.md", {
  flags: [{ code: "duplicate", message: "file trùng", related: [] }],
});
const B = file("/profiles/two/projects/project/memory/b.md", { profile: "claude-2" });
const INDEX = file("/profiles/one/projects/project/memory/MEMORY.md", {
  tokens: 1700,
  flags: [{ code: "over-limit", message: "vượt trần", related: [] }],
});
const DB = file("/codex/memories_1.sqlite", {
  cli: "codex",
  profile: "codex-1",
  projectKey: "",
  projectPath: "",
  kind: "database",
});
const OTHER = file("/other/a.md", { projectKey: "other", projectPath: "/repo/other" });

const inventory = (): MemoryInventory => ({
  files: [A, INDEX, B, DB, OTHER],
  sessions: [
    {
      cli: "claude",
      profile: "claude-1",
      projectKey: "project",
      projectPath: "/repo/app",
      sessionTokens: 1750,
      paths: [INDEX.path],
    },
    {
      cli: "claude",
      profile: "claude-2",
      projectKey: "project",
      projectPath: "/repo/app",
      sessionTokens: 50,
      paths: [],
    },
  ],
  shared: [],
  entries: [],
  warnings: [],
});

function fakeApp(
  options: {
    data?: MemoryInventory;
    scanError?: string;
    apply?: (operation: MemoryOperation) => MemoryResult | Promise<MemoryResult>;
    read?: (path: string) => Promise<string>;
  } = {},
) {
  const data = options.data ?? inventory();
  const operations: MemoryOperation[] = [];
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const success: MemoryResult = { applied: true, changed: [], warnings: [], conflicts: null, entry: "backup-1" };
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, ...(args ? { args } : {}) });
        if (command === "memory_scan") {
          if (options.scanError) throw new Error(options.scanError);
          return data as T;
        }
        if (command === "context_status") return { projects: [] } as T;
        if (command === "local_projects") {
          // /repo/app đã gắn với dự án hub; /repo/other chưa gắn.
          return {
            path: "/cfg/projects.json",
            exists: true,
            imported: 0,
            projects: [
              {
                projectId: "p-app",
                name: "App",
                folder: "/repo/app",
                fullPermission: false,
                exists: true,
                isGit: true,
              },
            ],
          } as T;
        }
        if (command === "memory_apply") {
          const operation = args?.operation as MemoryOperation;
          operations.push(operation);
          return (options.apply ? await options.apply(operation) : success) as T;
        }
        if (command === "read_local_file") {
          const path = `${args?.folder}/${args?.path}`;
          return {
            content: options.read ? await options.read(path) : `Nội dung ${args?.path}`,
            writable: true,
            size: 12,
            modifiedMs: 1,
          } as T;
        }
        throw new Error(`Lệnh ngoài phạm vi: ${command}`);
      },
    },
  };
  return { calls, operations, data };
}

const renderMemory = () =>
  render(
    <AccountContext.Provider value={null}>
      <MemoryScreen />
    </AccountContext.Provider>,
  );
const choose = (f: MemoryFile) => screen.getByRole("checkbox", { name: `Gộp file đã chọn: ${f.path}` });
const fileButton = (f: MemoryFile) =>
  within(screen.getByText(f.path).closest("li") as HTMLElement).getByRole("button", { name: f.name });
const openA = async () => {
  await screen.findByText(A.path);
  await userEvent.click(fileButton(A));
  return screen.findByRole("textbox", { name: "Nội dung" });
};

beforeEach(() => setLang("vi"));

describe("MemoryScreen", () => {
  it("hiện cây, token mỗi phiên, ngày sửa, cờ và database chỉ đọc khi chưa đăng nhập", async () => {
    const { calls } = fakeApp();
    renderMemory();
    await screen.findByText(A.path);
    const sessions = screen.getByRole("region", { name: "Token nạp mỗi phiên theo dự án và gói" });
    expect(within(sessions).getByText("1.750 token")).toBeTruthy();
    expect(within(sessions).getByText("50 token")).toBeTruthy();
    expect(screen.getByText("Trùng")).toBeTruthy();
    expect(screen.getByText(/Vượt 200 token/)).toBeTruthy();
    expect(screen.getByRole("button", { name: DB.name }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("checkbox", { name: /MEMORY.md/ })).toBeNull();
    expect(screen.getAllByText(/Sửa:.*14/).length).toBeGreaterThan(0);
    const ancestors = screen.getByText(A.path).closest("li")?.parentElement?.closest("details");
    expect(ancestors?.querySelector("summary")?.textContent).toContain("claude-1");
    expect(ancestors?.parentElement?.querySelector("summary")?.textContent).toContain("/repo/app");
    // context_status do mục Ngữ cảnh dùng chung gọi trong effect riêng, có thể chạy sau khi cây đã hiện.
    await waitFor(() =>
      expect(calls.map((c) => c.command).sort()).toEqual(["context_status", "local_projects", "memory_scan"]),
    );
  });

  it("hiện mục Ngữ cảnh dùng chung với dự án đã gắn và dự án có memory Claude trên máy", async () => {
    fakeApp();
    renderMemory();
    const section = await screen.findByRole("region", { name: "Ngữ cảnh dùng chung" });
    const options = (await within(section).findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["/repo/app", "/repo/other"]);
    expect(within(section).getByRole("button", { name: "Bật ngữ cảnh dùng chung" })).toBeTruthy();
  });

  it("mỗi gói Claude có memory có nút Nén bằng AI mở hộp gợi ý nén đúng gói và dự án", async () => {
    fakeApp();
    renderMemory();
    await screen.findByText(A.path);
    await userEvent.click(screen.getByRole("button", { name: "Nén memory của gói claude-2 bằng AI" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Gợi ý nén memory")).toBeTruthy();
    // Gói codex không có nút: nén chỉ dùng được với memory của Claude.
    expect(screen.queryByRole("button", { name: /gói codex-1/ })).toBeNull();
  });

  it("chỉ dự án đã gắn với hub có khung Đồng bộ với hub, và chỉ khi đã nối hub", async () => {
    fakeApp();
    const { unmount } = renderMemory();
    await screen.findByText(A.path);
    expect(screen.queryByText("Đồng bộ với hub")).toBeNull();
    unmount();
    const account = { name: "Hà", email: "ha@x.vn", orgId: "o", orgName: "O", orgRole: "member" as const, teams: [] };
    render(
      <AccountContext.Provider value={account}>
        <MemoryScreen />
      </AccountContext.Provider>,
    );
    await screen.findByText(A.path);
    const app = screen.getByText(A.path).closest("li")?.parentElement?.closest("details")?.parentElement as HTMLElement;
    expect(within(app).getByText("Đồng bộ với hub")).toBeTruthy();
    const other = screen.getByText(OTHER.path).closest("li")?.parentElement?.closest("details")
      ?.parentElement as HTMLElement;
    expect(within(other).queryByText("Đồng bộ với hub")).toBeNull();
  });

  it("sửa qua sidecar, truyền nội dung nguyên vẹn và khôi phục được bản sao lưu", async () => {
    const app = fakeApp({
      apply: (op) => {
        if (op.action === "edit")
          app.data.entries.push({
            id: "edit-backup",
            op: "edit",
            trash: false,
            createdAt: A.modifiedAt,
            paths: [A.path],
          });
        return { applied: true, entry: "edit-backup", changed: [A.path], warnings: ["Cảnh báo mẫu"], conflicts: null };
      },
    });
    renderMemory();
    const editor = await openA();
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Tiếng Việt\n"dấu nháy"');
    await userEvent.click(screen.getByRole("button", { name: "Lưu và sao lưu" }));
    await screen.findByText("Cảnh báo mẫu");
    expect(app.operations[0]).toEqual({ action: "edit", path: A.path, content: 'Tiếng Việt\n"dấu nháy"' });
    await userEvent.click(screen.getByRole("button", { name: "Khôi phục" }));
    await waitFor(() => expect(app.operations[1]).toEqual({ action: "restore", id: "edit-backup" }));
    expect(app.calls.some((c) => c.command === "write_local_file")).toBe(false);
  });

  it("xoá chỉ ghi sau xác nhận, bản thùng rác dùng mã khôi phục của worker", async () => {
    const app = fakeApp({
      apply: (op) => {
        if (op.action === "delete") {
          app.data.files = app.data.files.filter((f) => f.path !== op.path);
          app.data.entries.push({
            id: "trash-id",
            op: "delete",
            trash: true,
            createdAt: A.modifiedAt,
            paths: [A.path],
          });
        }
        return { applied: true, changed: [], warnings: [], conflicts: null };
      },
    });
    renderMemory();
    await openA();
    await userEvent.click(screen.getByRole("button", { name: "Xoá" }));
    expect(app.operations).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Huỷ" }));
    expect(app.operations).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Xoá" }));
    await userEvent.click(screen.getByRole("button", { name: "Chuyển vào thùng rác" }));
    await screen.findByRole("button", { name: "Khôi phục" });
    await userEvent.click(screen.getByRole("button", { name: "Khôi phục" }));
    await waitFor(() =>
      expect(app.operations).toEqual([
        { action: "delete", path: A.path },
        { action: "restore", id: "trash-id" },
      ]),
    );
  });

  it("gộp cùng dự án qua bản xem trước sửa được, đổi đích và huỷ chưa ghi", async () => {
    const app = fakeApp();
    renderMemory();
    await screen.findByText(A.path);
    await userEvent.click(choose(A));
    expect(choose(OTHER).hasAttribute("disabled")).toBe(true);
    await userEvent.click(choose(B));
    await userEvent.click(screen.getByRole("button", { name: "Gộp file đã chọn" }));
    let preview = await screen.findByRole("textbox", { name: "Xem trước bản gộp" });
    expect((preview as HTMLTextAreaElement).value).toContain("Nội dung a.md");
    expect((preview as HTMLTextAreaElement).value).toContain("Nội dung b.md");
    expect(app.operations).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Huỷ" }));
    expect(app.operations).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Gộp file đã chọn" }));
    preview = await screen.findByRole("textbox", { name: "Xem trước bản gộp" });
    await userEvent.clear(preview);
    await userEvent.type(preview, "Bản gộp đã duyệt");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "File đích" }), B.path);
    await userEvent.click(screen.getByRole("button", { name: "Áp dụng bản gộp" }));
    await waitFor(() =>
      expect(app.operations[0]).toEqual({
        action: "merge",
        sources: [A.path, B.path],
        target: B.path,
        content: "Bản gộp đã duyệt",
      }),
    );
  });

  it("dùng chung yêu cầu chọn từng xung đột, xem bản nguồn và tắt trả bản sao", async () => {
    const app = fakeApp({
      apply: (op) => {
        if (op.action === "share" && !op.picks)
          return {
            applied: false,
            changed: null,
            warnings: ["Chọn bản cần giữ"],
            conflicts: [{ name: "a.md", candidates: [A, B] }],
          };
        if (op.action === "share")
          app.data.shared.push({
            key: "project",
            projectPath: "/repo/app",
            sharedDir: "/shared/project",
            sharedAt: A.modifiedAt,
            profiles: [],
          });
        if (op.action === "unshare") app.data.shared = [];
        return { applied: true, changed: [], warnings: [], conflicts: null };
      },
    });
    renderMemory();
    await screen.findByText(A.path);
    // Mục Ngữ cảnh dùng chung có thể đã nạp xong và cũng có option "/repo/app": chỉ lấy tiêu đề của dự án.
    const project = screen.getByText("/repo/app", { selector: "summary" }).closest("details") as HTMLElement;
    await userEvent.click(within(project).getByRole("button", { name: "Dùng chung memory" }));
    await screen.findByText("Chọn bản memory cần giữ");
    expect(screen.getByRole("button", { name: "Áp dụng lựa chọn" }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getAllByRole("button", { name: "Xem bản này" })[1] as HTMLElement);
    expect(((await screen.findByRole("textbox", { name: "Nội dung" })) as HTMLTextAreaElement).value).toBe(
      "Nội dung b.md",
    );
    await userEvent.click(screen.getByRole("radio", { name: /claude-2/ }));
    await userEvent.click(screen.getByRole("button", { name: "Áp dụng lựa chọn" }));
    await screen.findByText("Đang dùng chung memory");
    expect(app.operations[1]).toEqual({
      action: "share",
      project: "project",
      folder: "/repo/app",
      picks: { "a.md": "claude-2" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Tắt dùng chung" }));
    await waitFor(() => expect(app.operations[2]).toEqual({ action: "unshare", project: "project" }));
  });

  it("lỗi ghi giữ bản nháp để thử lại", async () => {
    const app = fakeApp({
      apply: async () => {
        throw new Error("Không ghi được memory.");
      },
    });
    renderMemory();
    const editor = await openA();
    await userEvent.clear(editor);
    await userEvent.type(editor, "Bản nháp");
    await userEvent.click(screen.getByRole("button", { name: "Lưu và sao lưu" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Không ghi được memory.");
    expect((screen.getByRole("textbox", { name: "Nội dung" }) as HTMLTextAreaElement).value).toBe("Bản nháp");
    expect(app.operations).toHaveLength(1);
  });

  it("lỗi đọc không cho lưu nội dung rỗng", async () => {
    fakeApp({
      read: async () => {
        throw new Error("Không đọc được file.");
      },
    });
    renderMemory();
    await screen.findByText(A.path);
    await userEvent.click(screen.getByRole("button", { name: "b.md" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Lưu và sao lưu" })).toBeNull();
  });

  it("lần đọc cũ hoàn tất không thay nội dung của file mới chọn", async () => {
    let finish: ((value: string) => void) | undefined;
    fakeApp({
      read: (path) =>
        path === A.path
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve("File B"),
    });
    renderMemory();
    await screen.findByText(A.path);
    await userEvent.click(fileButton(A));
    expect(finish).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "b.md" }));
    await screen.findByRole("textbox", { name: "Nội dung" });
    await act(async () => {
      finish?.("File A cũ");
    });
    expect((screen.getByRole("textbox", { name: "Nội dung" }) as HTMLTextAreaElement).value).toBe("File B");
  });

  it("khoá thao tác trong lúc sidecar ghi", async () => {
    let finish: ((value: MemoryResult) => void) | undefined;
    const app = fakeApp({
      apply: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    renderMemory();
    const editor = await openA();
    await userEvent.type(editor, " mới");
    await userEvent.click(screen.getByRole("button", { name: "Lưu và sao lưu" }));
    expect(screen.getByRole("button", { name: "Lưu và sao lưu" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Đọc lại" }).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      finish?.({ applied: true, warnings: [], changed: [], conflicts: null });
    });
    expect(app.operations).toHaveLength(1);
  });

  it("hiện lỗi quét và cho đọc lại; dữ liệu rỗng có bản tiếng Anh", async () => {
    fakeApp({ scanError: "Không quét được memory." });
    renderMemory();
    expect((await screen.findByRole("alert")).textContent).toContain("Không quét được memory.");
    const app = fakeApp({ data: { files: [], sessions: [], entries: [], shared: [], warnings: [] } });
    await userEvent.click(screen.getByRole("button", { name: "Đọc lại" }));
    await screen.findByText("Chưa tìm thấy memory hoặc hướng dẫn trên máy.");
    act(() => setLang("en"));
    expect(screen.getByText("No local memory or instructions found.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(app.operations).toEqual([]);
  });
});

describe("cầu nối và đăng ký Memory", () => {
  it("slice null của Go được chuẩn hoá và cây giữ CLI → dự án → gói", async () => {
    window.__TAURI__ = {
      core: {
        invoke: vi.fn().mockResolvedValue({ files: null, sessions: null, warnings: null, shared: null, entries: null }),
      },
    };
    expect(await scanMemory()).toEqual({ files: [], sessions: [], warnings: [], shared: [], entries: [] });
    const tree = memoryTree([B, A, DB]);
    expect(tree.map((c) => c.cli)).toEqual(["claude", "codex"]);
    expect(tree[0]?.projects[0]?.profiles.map((p) => p.id)).toEqual(["claude-2", "claude-1"]);
  });

  it("đọc đường dẫn Windows giữ khoảng trắng; thao tác gửi đúng lệnh Tauri", async () => {
    const app = fakeApp();
    await readMemory("C:\\Gói Claude\\memory\\a.md");
    expect(app.calls[0]).toEqual({
      command: "read_local_file",
      args: { folder: "C:\\Gói Claude\\memory", path: "a.md" },
    });
    await applyMemory({ action: "restore", id: "backup" });
    expect(app.operations[0]).toEqual({ action: "restore", id: "backup" });
  });

  it("menu cục bộ có Memory cho mọi hồ sơ và mở được từ hash", () => {
    expect(screenFromHash("#/memory")).toBe("memory");
    expect(NAV_ITEMS.find((item) => item.id === "memory")?.hub).toBeUndefined();
    for (const profile of ["dev", "writer", "lead"] as const)
      expect(navItems(profile).some((item) => item.id === "memory")).toBe(true);
  });
});
