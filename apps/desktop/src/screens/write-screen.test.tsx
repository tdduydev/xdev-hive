import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import { useWriteDocEnv, WriteScreen } from "@/screens/write-screen.tsx";

const at = "2026-10-13T00:00:00.000Z";
const key = "project/hive/prd-refund";
const team = "0a0a0a0a-0000-4000-8000-000000000002";
const project = "0a0a0a0a-0000-4000-8000-000000000003";

const doc = {
  id: "0a0a0a0a-0000-4000-8000-000000000004",
  key,
  title: "Hoàn tiền một phần",
  scope: { level: "project", teamId: team, projectId: project },
  version: 2,
  updatedAt: at,
  updatedBy: { userId: "u1", runId: null },
};

const state = {
  draft: {
    key,
    title: "Hoàn tiền một phần",
    content: "## Yêu cầu\n\n- R-1: Hoàn tiền một phần.\n",
    scope: doc.scope,
    baseVersion: 2,
    latestVersion: 2,
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    canEdit: true,
  },
  presence: [],
  workflow: null,
  review: null,
  stage: "drafting",
  draftNumber: 1,
  openComments: 0,
  pendingSuggestions: 0,
};

const file = {
  homeId: "0a0a0a0a-0000-4000-8000-000000000005",
  path: "docs/prd-refund.md",
  key,
  title: doc.title,
  kind: "doc",
  state: "pending",
  prNumber: 42,
  prUrl: "https://github.com/team/hive/pull/42",
  repoUrl: "https://github.com/team/hive/blob/main/docs/prd-refund.md",
  repoCommit: "a".repeat(40),
  docId: doc.id,
  assetId: null,
  version: 2,
  error: null,
};
const conflict = {
  id: "0a0a0a0a-0000-4000-8000-000000000006",
  homeId: file.homeId,
  docId: doc.id,
  key,
  title: doc.title,
  repoPath: file.path,
  baseVersion: 1,
  hubVersion: 2,
  repoCommit: "b".repeat(40),
  state: "open",
  resolution: null,
  resolvedVersion: null,
  createdAt: at,
  updatedAt: at,
  baseContent: "# Gốc\n",
  hubContent: "# Hub\n",
  repoContent: "# Repo\n",
  merge: { content: "# Hub\n", conflicts: 1 },
};

/** Hub giả sau lệnh hub_rpc: trả theo thủ tục trong đường dẫn RPC, ghi lại thủ tục đã gọi. */
function fakeHub(overrides: Record<string, unknown> = {}) {
  const paths: string[] = [];
  const inputs: Array<{ path: string; input: unknown }> = [];
  const replies: Record<string, unknown> = {
    "docs/list": [doc],
    "docTree/list": { items: [file], nextCursor: null },
    "docConflicts/list": { items: [conflict], nextCursor: null },
    "docConflicts/get": conflict,
    "docConflicts/resolve": { key, version: 3 },
    "docEditor/state": state,
    "docEditor/suggestions/list": [],
    "docEditor/comments/list": [],
    ...overrides,
  };
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command !== "hub_rpc") throw new Error(`lệnh chưa giả: ${command}`);
        const path =
          String(args?.path)
            .replace(/^\/rpc\//, "")
            .split("?")[0] ?? "";
        paths.push(path);
        const url = new URL(String(args?.path), "http://hub.local");
        const payload = args?.body ?? url.searchParams.get("data");
        const input = payload ? JSON.parse(String(payload)).json : undefined;
        inputs.push({ path, input });
        const reply = replies[path];
        const body = typeof reply === "function" ? reply(input) : reply;
        if (body instanceof Error) throw body;
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
  return { paths, inputs };
}

describe("WriteScreen", () => {
  beforeEach(() => {
    setLang("vi");
    location.hash = "#/write";
  });

  it("liệt kê tài liệu từ hub, chọn thì mở trình soạn dùng chung với key đó", async () => {
    const { paths } = fakeHub();
    render(<WriteScreen />);
    const row = await screen.findByRole("button", { name: /Hoàn tiền một phần/ });
    expect(paths).toContain("docs/list");
    await userEvent.setup().click(row);
    expect(location.hash).toBe(`#/write/${encodeURIComponent(key)}`);
    // Trình soạn tải lười cả khối Tiptap; máy tải nặng thì quá 1 giây mặc định.
    expect(await screen.findByDisplayValue("Hoàn tiền một phần")).toBeTruthy();
    expect(paths).toContain("docEditor/state");
  }, 15_000);

  it("key tài liệu mới sai dạng thì báo ngay, không mở trình soạn", async () => {
    fakeHub();
    render(<WriteScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Tài liệu mới"), "Không Hợp Lệ");
    await user.click(screen.getByRole("button", { name: "Mở trình soạn" }));
    expect(location.hash).toBe("#/write");
    expect(screen.getByLabelText("Tài liệu mới").getAttribute("aria-invalid")).toBe("true");
  });

  it("hiện PR trong danh sách và editor, link repo mở đúng file", async () => {
    fakeHub();
    render(<WriteScreen />);
    expect(await screen.findByText("PR #42 đang mở")).toBeTruthy();
    expect(screen.getByRole("link", { name: "PR #42" }).getAttribute("href")).toBe(file.prUrl);
    expect(screen.getByRole("region", { name: "Tài liệu theo thư mục repo" })).toBeTruthy();
    expect(screen.getByText(/docs\/prd-refund\.md/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mở commit trên repo" }).getAttribute("href")).toBe(
      `https://github.com/team/hive/commit/${file.repoCommit}`,
    );
    await userEvent.click(screen.getByRole("button", { name: /Hoàn tiền một phần/ }));
    expect(await screen.findByRole("link", { name: "Mở file trên repo" })).toBeTruthy();
    expect(screen.getByText("PR #42 đang mở")).toBeTruthy();
  });

  it("đọc tiếp trang cây trước khi gắn nhãn chưa có nhà", async () => {
    const { inputs } = fakeHub({
      "docTree/list": (input: { cursor?: string }) =>
        input.cursor ? { items: [file], nextCursor: null } : { items: [], nextCursor: "next-page" },
    });
    render(<WriteScreen />);
    expect(await screen.findByText("PR #42 đang mở")).toBeTruthy();
    expect(inputs).toContainEqual({ path: "docTree/list", input: { limit: 200, cursor: "next-page" } });
  });

  it("tìm bằng hub, hiện chế độ theo từ và đoạn khớp; xoá tìm kiếm trở về danh sách", async () => {
    const { inputs } = fakeHub({
      "docs/search": {
        mode: "keyword",
        hits: [
          {
            key: "org/quy-trinh",
            title: "Quy trình kiểm thử",
            headingPath: ["Kiểm thử"],
            snippet: "Mô tả nội dung cần tìm",
            repoPath: null,
            extractId: null,
          },
        ],
      },
    });
    render(<WriteScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox"), "  kiểm thử  ");
    await user.click(screen.getByRole("button", { name: "Tìm tài liệu" }));
    expect(await screen.findByRole("button", { name: /Quy trình kiểm thử/ })).toBeTruthy();
    expect(screen.getByText(/hub chưa cấu hình tìm theo nghĩa/)).toBeTruthy();
    expect(inputs).toContainEqual({ path: "docs/search", input: { query: "kiểm thử" } });
    expect(screen.queryByRole("button", { name: /Hoàn tiền một phần/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Xoá tìm kiếm" }));
    expect(await screen.findByRole("button", { name: /Hoàn tiền một phần/ })).toBeTruthy();
  });

  it("đổi sang tiếng Anh và báo không có kết quả tìm theo nghĩa", async () => {
    setLang("en");
    fakeHub({ "docs/search": { mode: "hybrid", hits: [] }, "docTree/list": { items: [], nextCursor: null } });
    render(<WriteScreen />);
    expect((await screen.findAllByText("No home")).length).toBeGreaterThan(0);
    await userEvent.type(screen.getByRole("searchbox"), "refund");
    await userEvent.click(screen.getByRole("button", { name: "Search documents" }));
    expect(await screen.findByText("No matching documents.")).toBeTruthy();
    expect(screen.getByText("Results combine keyword and semantic search.")).toBeTruthy();
  });

  it.each(["hub", "repo", "manual"] as const)("giải quyết xung đột bằng %s và tải lại dữ liệu", async (choice) => {
    location.hash = `#/write/${encodeURIComponent(key)}`;
    let resolved = false;
    const { inputs, paths } = fakeHub({
      "docTree/list": () => ({ items: [{ ...file, state: resolved ? "pending" : "conflict" }], nextCursor: null }),
      "docConflicts/resolve": () => {
        resolved = true;
        return { key, version: 3 };
      },
    });
    render(<WriteScreen />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Giải quyết xung đột" }));
    expect(await screen.findByRole("region", { name: "Ba bản của tài liệu" })).toBeTruthy();
    if (choice === "manual") {
      await user.click(screen.getByRole("button", { name: "Sửa tay" }));
      const content = screen.getByRole("textbox", { name: "Bản hợp có đánh dấu" });
      await user.clear(content);
      await user.type(content, "# Bản đã hợp");
      await user.click(screen.getByRole("button", { name: "Lưu bản đã sửa" }));
    } else {
      await user.click(screen.getByRole("button", { name: choice === "hub" ? "Giữ bản hub" : "Giữ bản repo" }));
    }
    expect(await screen.findByDisplayValue("Hoàn tiền một phần")).toBeTruthy();
    expect(inputs).toContainEqual({
      path: "docConflicts/resolve",
      input: {
        id: conflict.id,
        choice,
        baseVersion: 2,
        ...(choice === "manual" ? { content: "# Bản đã hợp" } : {}),
      },
    });
    expect(paths.filter((path) => path === "docTree/list").length).toBeGreaterThan(1);
  });

  it("giữ màn xung đột và hiện lỗi hub khi không được phép giải quyết", async () => {
    location.hash = `#/write/${encodeURIComponent(key)}`;
    fakeHub({
      "docTree/list": { items: [{ ...file, state: "conflict" }], nextCursor: null },
      "docConflicts/resolve": new Error("Bạn không có quyền quản lý tài liệu."),
    });
    render(<WriteScreen />);
    await userEvent.click(await screen.findByRole("button", { name: "Giải quyết xung đột" }));
    await userEvent.click(await screen.findByRole("button", { name: "Giữ bản repo" }));
    expect(await screen.findByText("Bạn không có quyền quản lý tài liệu.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Ba bản của tài liệu" })).toBeTruthy();
  });

  it("phân giải link tài liệu tương đối qua hub và giữ key đích để điều hướng nội bộ", async () => {
    const { inputs } = fakeHub({
      "docAssets/resolve": [{ kind: "doc", href: "./khac.md", key: "project/hive/khac" }],
    });
    const { result } = renderHook(() => useWriteDocEnv());
    expect(await result.current.resolveLink?.(key, "./khac.md")).toMatchObject({
      kind: "doc",
      key: "project/hive/khac",
    });
    expect(inputs).toContainEqual({ path: "docAssets/resolve", input: { docKey: key, hrefs: ["./khac.md"] } });
  });

  it("link không tìm thấy không điều hướng tới URL của WebView", async () => {
    fakeHub({ "docAssets/resolve": [{ kind: "missing", href: "./khong-co.md", reason: "Không tìm thấy tài liệu." }] });
    const { result } = renderHook(() => useWriteDocEnv());
    expect(await result.current.resolveLink?.(key, "./khong-co.md")).toBeNull();
  });
});
