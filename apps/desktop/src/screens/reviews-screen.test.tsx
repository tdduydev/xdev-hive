import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import { ReviewsScreen } from "@/screens/reviews-screen.tsx";

const at = "2026-10-13T00:00:00.000Z";
const id = "0a0a0a0a-0000-4000-8000-000000000001";

const summary = {
  id,
  proposalId: "0a0a0a0a-0000-4000-8000-000000000002",
  docKey: "project/hive/prd-refund",
  docTitle: "Hoàn tiền một phần",
  docType: "prd",
  workflowId: "0a0a0a0a-0000-4000-8000-000000000003",
  workflowName: "AI-DLC",
  status: "in_review",
  gate: { id: "po", name: "PO duyệt", kind: "human", phase: "Inception", index: 1, total: 3, dueAt: null, sla: "none" },
  author: { userId: "u2", runId: null, name: "Lan" },
  awaitingMe: true,
  aiScore: 8.5,
  addedLines: 1,
  deletedLines: 0,
  createdAt: at,
  updatedAt: at,
};

const detail = (status = "in_review") => ({
  ...summary,
  status,
  gate: status === "in_review" ? summary.gate : null,
  baseVersion: 1,
  baseContent: "## Yêu cầu\n",
  content: "## Yêu cầu\n\n- R-1: Hoàn tiền một phần.\n",
  reason: null,
  gates: [
    {
      gateId: "po",
      name: "PO duyệt",
      kind: "human",
      phase: "Inception",
      status: status === "in_review" ? "waiting" : "passed",
      score: null,
      checklist: [],
      approvals: [],
      note: null,
      decidedBy: null,
      startedAt: at,
      finishedAt: null,
      runId: null,
    },
  ],
  trace: [],
  canDecide: status === "in_review",
  previousGate: null,
  currentGate: null,
});

/** Hub giả sau lệnh hub_rpc: trả theo thủ tục RPC, ghi lại thủ tục, query và thân request. */
function fakeHub(replies: Record<string, unknown>) {
  const calls: { path: string; query: string; body: unknown }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command !== "hub_rpc") throw new Error(`lệnh chưa giả: ${command}`);
        const [path = "", query = ""] = String(args?.path)
          .replace(/^\/rpc\//, "")
          .split("?");
        calls.push({ path, query: decodeURIComponent(query), body: args?.body ? JSON.parse(String(args.body)) : null });
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

describe("ReviewsScreen", () => {
  beforeEach(() => {
    setLang("vi");
    location.hash = "#/reviews";
  });

  it("chỉ liệt kê phiên chờ tôi, mở một phiên thì thấy thay đổi so với bản đã duyệt", async () => {
    const calls = fakeHub({ "reviews/list": { items: [summary], nextCursor: null }, "reviews/get": detail() });
    render(<ReviewsScreen />);
    const row = await screen.findByRole("button", { name: "Duyệt Hoàn tiền một phần" });
    expect(calls.find((c) => c.path === "reviews/list")?.query).toContain('"scope":"mine"');
    await userEvent.setup().click(row);
    expect(location.hash).toBe(`#/reviews/${id}`);
    expect(await screen.findByText("- R-1: Hoàn tiền một phần.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Duyệt" })).toBeTruthy();
  });

  it("trả lại cần góp ý, gửi đúng quyết định, góp ý và hướng trả lại", async () => {
    location.hash = `#/reviews/${id}`;
    const calls = fakeHub({
      "reviews/list": { items: [], nextCursor: null },
      "reviews/get": detail(),
      "reviews/decide": detail("changes_requested"),
    });
    render(<ReviewsScreen />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Yêu cầu sửa" }));
    expect(await screen.findByText("Ghi góp ý khi trả lại.")).toBeTruthy();
    expect(calls.some((c) => c.path === "reviews/decide")).toBe(false);

    await user.type(screen.getByLabelText("Góp ý cho người viết"), "Thiếu tiêu chí chấp nhận");
    await user.selectOptions(screen.getByLabelText("Nếu yêu cầu sửa"), "agent");
    await user.click(screen.getByRole("button", { name: "Yêu cầu sửa" }));
    expect(await screen.findByText(/Đã trả lại/)).toBeTruthy();
    expect(calls.find((c) => c.path === "reviews/decide")?.body).toEqual({
      json: { id, decision: "changes", note: "Thiếu tiêu chí chấp nhận", route: "agent" },
    });
  });

  it("không có gì chờ thì báo trống", async () => {
    fakeHub({ "reviews/list": { items: [], nextCursor: null } });
    render(<ReviewsScreen />);
    expect(await screen.findByText("Không có tài liệu nào chờ bạn duyệt.")).toBeTruthy();
  });
});
