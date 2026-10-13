import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import { WriteScreen } from "@/screens/write-screen.tsx";

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

/** Hub giả sau lệnh hub_rpc: trả theo thủ tục trong đường dẫn RPC, ghi lại thủ tục đã gọi. */
function fakeHub() {
  const paths: string[] = [];
  const replies: Record<string, unknown> = {
    "docs/list": [doc],
    "docEditor/state": state,
    "docEditor/suggestions/list": [],
    "docEditor/comments/list": [],
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
  return paths;
}

describe("WriteScreen", () => {
  beforeEach(() => {
    setLang("vi");
    location.hash = "#/write";
  });

  it("liệt kê tài liệu từ hub, chọn thì mở trình soạn dùng chung với key đó", async () => {
    const paths = fakeHub();
    render(<WriteScreen />);
    const row = await screen.findByRole("button", { name: /Hoàn tiền một phần/ });
    expect(paths).toContain("docs/list");
    await userEvent.setup().click(row);
    expect(location.hash).toBe(`#/write/${encodeURIComponent(key)}`);
    // Trình soạn tải lười cả khối Tiptap; máy tải nặng thì quá 1 giây mặc định.
    expect(await screen.findByDisplayValue("Hoàn tiền một phần", {}, { timeout: 10_000 })).toBeTruthy();
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
});
