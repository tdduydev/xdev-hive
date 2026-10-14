import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { api, queryClient } from "@/lib/hub-query.tsx";
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

const codeId = "0a0a0a0a-0000-4000-8000-000000000010";
const head = "a".repeat(40);

const codeSummary = {
  id: codeId,
  project: { id: "0a0a0a0a-0000-4000-8000-000000000011", key: "payment-api", name: "Payment API" },
  task: { id: "0a0a0a0a-0000-4000-8000-000000000012", key: "PAY-142", title: "Hoàn tiền một phần" },
  pr: {
    number: 128,
    url: "https://github.com/acme/pay/pull/128",
    branch: "ai/PAY-142",
    baseBranch: "main",
    headSha: head,
  },
  workflow: { id: "0a0a0a0a-0000-4000-8000-000000000013", name: "Code cơ bản" },
  status: "in_review",
  round: 1,
  gate: {
    id: "po",
    name: "PO duyệt",
    kind: "human",
    phase: "Người duyệt",
    index: 1,
    total: 2,
    dueAt: null,
    sla: "none",
  },
  requester: { userId: "u9", name: "Lan" },
  awaitingMe: true,
  aiScore: 8,
  addedLines: 12,
  deletedLines: 3,
  changedFiles: 2,
  createdAt: at,
  updatedAt: at,
};

const codeDetail = (over: Record<string, unknown> = {}) => ({
  ...codeSummary,
  runId: "0a0a0a0a-0000-4000-8000-000000000014",
  runReasons: [],
  route: null,
  agentRevisions: 0,
  maxAgentRevisions: 2,
  mergeMode: "manual",
  inMergeQueue: false,
  gates: [
    {
      gateId: "po",
      name: "PO duyệt",
      kind: "human",
      phase: "Người duyệt",
      index: 1,
      status: "waiting",
      score: null,
      checklist: [],
      approvals: [],
      note: null,
      decidedBy: null,
      overridden: false,
      dueAt: null,
      sla: "none",
      startedAt: at,
      finishedAt: null,
      reviewers: [],
      commands: [],
      ci: null,
    },
  ],
  rounds: [
    {
      id: codeId,
      round: 1,
      headSha: head,
      status: "in_review",
      runId: "0a0a0a0a-0000-4000-8000-000000000014",
      createdAt: at,
    },
  ],
  currentGate: {
    id: "po",
    name: "PO duyệt",
    kind: "human",
    reviewers: { users: [], roles: [], teams: [], quorum: 1 },
    conditions: { docTypes: [], keywords: [], minChangedLines: null, skipFormattingOnly: false },
    slaHours: null,
    onReject: "agent",
    onPass: "next",
  },
  previousGate: null,
  canDecide: true,
  canOverride: false,
  canEnqueue: false,
  canRecheck: false,
  ...over,
});

/** Hub giả sau lệnh hub_rpc: trả theo thủ tục RPC, ghi lại thủ tục, query và thân request. */
function fakeHub(replies: Record<string, unknown | (() => unknown)>) {
  const calls: { path: string; query: string; body: unknown }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command !== "hub_rpc") throw new Error(`lệnh chưa giả: ${command}`);
        const [path = "", query = ""] = String(args?.path)
          .replace(/^\/rpc\//, "")
          .split("?");
        calls.push({ path, query: decodeURIComponent(query), body: args?.body ? JSON.parse(String(args.body)) : null });
        const reply = replies[path];
        const body = typeof reply === "function" ? reply() : reply;
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

  it("hiện hai tab có số đếm và chuyển sang hàng chờ PR", async () => {
    const calls = fakeHub({
      "reviews/list": { items: [summary], nextCursor: null },
      "codeReviews/count": { awaitingMe: 2 },
      "codeReviews/list": { items: [codeSummary], nextCursor: null },
    });
    render(<ReviewsScreen />);
    const code = await screen.findByRole("tab", { name: /Code/ });
    expect((await screen.findByRole("tab", { name: /Tài liệu/ })).getAttribute("aria-selected")).toBe("true");
    await userEvent.setup().click(code);
    expect(location.hash).toBe("#/reviews/code");
    const row = await screen.findByRole("button", { name: "Duyệt PR Hoàn tiền một phần" });
    expect(row.textContent).toContain("#128");
    expect(calls.find((c) => c.path === "codeReviews/list")?.query).toContain('"scope":"mine"');
    expect(screen.getByRole("tab", { name: /Code/ }).textContent).toContain("2");
  });

  it("PR không có gì chờ thì báo trống", async () => {
    location.hash = "#/reviews/code";
    fakeHub({
      "reviews/list": { items: [], nextCursor: null },
      "codeReviews/count": { awaitingMe: 0 },
      "codeReviews/list": { items: [], nextCursor: null },
    });
    render(<ReviewsScreen />);
    expect(await screen.findByText("Không có PR nào chờ bạn duyệt.")).toBeTruthy();
  });

  it("mở PR theo #/reviews/code/<id>, duyệt gửi đúng headSha của PR đã xem", async () => {
    location.hash = `#/reviews/code/${codeId}`;
    const calls = fakeHub({
      "codeReviews/get": codeDetail(),
      "codeReviews/files": { headSha: head, files: [], truncated: false },
      "codeReviews/decide": codeDetail({ status: "approved", gate: null, canDecide: false }),
      "codeReviews/list": { items: [], nextCursor: null },
      "codeReviews/count": { awaitingMe: 0 },
    });
    render(<ReviewsScreen />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Duyệt" }));
    await waitFor(() => expect(calls.some((c) => c.path === "codeReviews/decide")).toBe(true));
    expect(calls.find((c) => c.path === "codeReviews/decide")?.body).toEqual({
      json: { id: codeId, headSha: head, decision: "approve" },
    });
    expect(await screen.findByText(/Đã duyệt/)).toBeTruthy();
  });

  it("trả lại PR cần góp ý và không gọi hub khi thiếu", async () => {
    location.hash = `#/reviews/code/${codeId}`;
    const calls = fakeHub({
      "codeReviews/get": codeDetail(),
      "codeReviews/files": { headSha: head, files: [], truncated: false },
    });
    render(<ReviewsScreen />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Trả lại" }));
    expect(await screen.findByText("Ghi góp ý khi trả lại.")).toBeTruthy();
    expect(calls.some((c) => c.path === "codeReviews/decide")).toBe(false);
  });

  it("checkpoint tự động: không có khung quyết thay hay chạy lại, kể cả khi hub cho quyền", async () => {
    location.hash = `#/reviews/code/${codeId}`;
    fakeHub({
      "codeReviews/get": codeDetail({
        gate: { ...codeSummary.gate, id: "ai", name: "AI review", kind: "ai" },
        canDecide: false,
        canOverride: true,
        canRecheck: true,
      }),
      "codeReviews/files": { headSha: head, files: [], truncated: false },
    });
    render(<ReviewsScreen />);
    expect((await screen.findAllByText(/Hoàn tiền một phần/)).length).toBeGreaterThan(0);
    expect(screen.queryByText("Quyết thay checkpoint tự động")).toBeNull();
    expect(screen.queryByRole("button", { name: /Quyết thay/ })).toBeNull();
  });

  it("PR có commit mới thì báo và chặn quyết định cho tới khi tải lại", async () => {
    location.hash = `#/reviews/code/${codeId}`;
    const newer = "b".repeat(40);
    let served = codeDetail();
    fakeHub({
      "codeReviews/get": () => served,
      "codeReviews/files": { headSha: head, files: [], truncated: false },
    });
    const view = render(<ReviewsScreen />);
    await screen.findByRole("button", { name: "Duyệt" });
    served = codeDetail({ pr: { ...codeDetail().pr, headSha: newer } });
    await queryClient.refetchQueries({ queryKey: api.codeReviews.get.key() });
    expect(await screen.findByText(/commit mới/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Duyệt" }) as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
  });
});
