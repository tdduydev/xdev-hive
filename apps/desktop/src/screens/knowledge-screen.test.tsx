import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import { KnowledgeScreen } from "@/screens/knowledge-screen.tsx";

const at = "2026-10-13T00:00:00.000Z";
const scope = { level: "org", teamId: null, projectId: null };
const by = { userId: "u1", runId: null };
const key = "project/pay/prd-refund";

const doc = {
  id: "0a0a0a0a-0000-4000-8000-000000000001",
  key,
  title: "Hoàn tiền một phần",
  scope,
  version: 3,
  updatedAt: at,
  updatedBy: by,
};
const other = { ...doc, id: "0a0a0a0a-0000-4000-8000-000000000002", key: "org/onboarding", title: "Nhập môn" };
const skill = {
  id: "0a0a0a0a-0000-4000-8000-000000000003",
  name: "refund-flow",
  description: "Quy trình hoàn tiền qua cổng thanh toán",
  scope,
  version: 1,
  updatedAt: at,
  updatedBy: by,
};
const memory = {
  id: "0a0a0a0a-0000-4000-8000-000000000004",
  kind: "decision",
  content: "Hoàn tiền một phần đi qua bảng refunds, không sửa payments.",
  files: ["apps/pay/refund.ts"],
  scope,
  author: by,
  createdAt: at,
  supersededBy: null,
  score: 0.9,
  matchedBy: ["text"],
};

/** Hub giả sau lệnh hub_rpc: trả theo thủ tục RPC, ghi lại thủ tục và query. */
function fakeHub(replies: Record<string, unknown>) {
  const calls: { path: string; query: string }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command !== "hub_rpc") throw new Error(`lệnh chưa giả: ${command}`);
        const [path = "", query = ""] = String(args?.path)
          .replace(/^\/rpc\//, "")
          .split("?");
        calls.push({ path, query: new URLSearchParams(query).get("data") ?? "" });
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

describe("KnowledgeScreen", () => {
  beforeEach(() => {
    setLang("vi");
    location.hash = "#/knowledge";
  });

  it("một câu tìm cho tài liệu, memory và skill; bỏ dấu vẫn khớp", async () => {
    const calls = fakeHub({
      "docs/list": [doc, other],
      "skills/list": [skill],
      "memory/search": [memory],
      "docs/get": { ...doc, content: "## Yêu cầu\n\n- R-1: Hoàn tiền một phần." },
    });
    render(<KnowledgeScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Tìm tri thức"), "hoan tien");
    await user.click(screen.getByRole("button", { name: "Tìm" }));

    const docs = await screen.findByRole("region", { name: "Tài liệu" });
    expect(await within(docs).findByText("Hoàn tiền một phần")).toBeTruthy();
    expect(within(docs).queryByText("Nhập môn")).toBeNull();
    expect(await screen.findByText(/đi qua bảng refunds/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Skill" })).getByText("refund-flow")).toBeTruthy();
    expect(calls.find((c) => c.path === "memory/search")?.query).toContain('"query":"hoan tien"');

    await user.click(within(docs).getByText("Hoàn tiền một phần"));
    expect(location.hash).toBe(`#/knowledge/doc/${encodeURIComponent(key)}`);
  });

  it("mở tài liệu là bản chỉ đọc, có nút sang trình soạn", async () => {
    location.hash = `#/knowledge/doc/${encodeURIComponent(key)}`;
    fakeHub({ "docs/get": { ...doc, content: "## Yêu cầu\n\n- R-1: Hoàn tiền một phần." } });
    render(<KnowledgeScreen />);
    expect(await screen.findByText("R-1: Hoàn tiền một phần.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Sửa trong trình soạn" }));
    expect(location.hash).toBe(`#/write/${encodeURIComponent(key)}`);
  });

  it("không khớp gì thì báo không có kết quả", async () => {
    fakeHub({ "docs/list": [doc], "skills/list": [skill], "memory/search": [] });
    render(<KnowledgeScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Tìm tri thức"), "kubernetes");
    await user.click(screen.getByRole("button", { name: "Tìm" }));
    expect((await screen.findAllByText("Không có kết quả.")).length).toBe(3);
  });
});
