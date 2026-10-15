// @vitest-environment jsdom
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CodeReviewDetail, Contract } from "@xdev-hive/contracts";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeReviewsTab } from "@/pages/knowledge/code-reviews-tab.tsx";

vi.mock("@/shell/org-context.ts", () => ({ useOrg: () => ({ api, org: { id: "org-1" } }) }));
vi.mock("@/shell/me-context.ts", () => ({ useMe: () => ({ id: "u1" }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));

const id = "00000000-0000-4000-8000-000000000001";
const headSha = "a".repeat(40);
const at = "2026-10-15T00:00:00Z";
const detail: CodeReviewDetail = {
  id,
  project: { id, key: "hive", name: "Hive" },
  task: null,
  pr: { number: 1, url: "https://github.com/a/b/pull/1", branch: "feature", baseBranch: "main", headSha },
  workflow: { id, name: "Code" },
  status: "approved",
  round: 1,
  gate: null,
  requester: null,
  awaitingMe: false,
  aiScore: null,
  addedLines: 1,
  deletedLines: 0,
  changedFiles: 1,
  createdAt: at,
  updatedAt: at,
  runId: id,
  runReasons: [],
  route: null,
  agentRevisions: 0,
  maxAgentRevisions: 2,
  mergeMode: "manual",
  inMergeQueue: false,
  gates: [],
  rounds: [],
  currentGate: null,
  previousGate: null,
  canDecide: false,
  canOverride: false,
  canEnqueue: false,
  canRecheck: false,
};
const comment = () => ({
  id: "c1",
  threadId: "t1",
  authorId: "u1",
  authorName: "Duy",
  body: "Cần test",
  origin: "hive",
  externalAuthor: null,
  createdAt: at,
  editedAt: null,
  deletedAt: null as string | null,
});
const thread = () => ({
  id: "t1",
  path: "a.ts",
  line: 1,
  side: "new",
  headSha,
  outdated: false,
  resolved: false,
  resolvedAt: null,
  resolvedBy: null,
  comments: [comment()],
});
let current = thread();
let listFails = false;
const calls: { path: string; input: unknown }[] = [];
const client: ContractRouterClient<Contract> = createORPCClient(
  new RPCLink({
    url: "http://test/rpc",
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname.replace("/rpc/", "");
      const input = (await request.json()).json;
      calls.push({ path, input });
      if (path === "codeReviews/comments/list" && listFails) throw new Error("Mất kết nối");
      const replies: Record<string, () => unknown> = {
        "codeReviews/list": () => ({ items: [], nextCursor: null }),
        "codeReviews/get": () => detail,
        "codeReviews/files": () => ({
          headSha,
          truncated: false,
          files: [
            {
              path: "a.ts",
              previousPath: null,
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -0,0 +1 @@\n+new",
              truncated: false,
            },
          ],
        }),
        "codeReviews/comments/list": () => ({ threads: [current] }),
        "codeReviews/comments/add": () => current,
        "codeReviews/comments/reply": () => current.comments[0],
        "codeReviews/comments/edit": () => current.comments[0],
        "codeReviews/comments/delete": () => {
          current.comments[0]!.deletedAt = at;
          return { ok: true };
        },
        "codeReviews/comments/resolve": () => {
          current.resolved = true;
          return current;
        },
        "codeReviews/comments/reopen": () => {
          current.resolved = false;
          return current;
        },
      };
      return new Response(JSON.stringify({ json: replies[path]?.() }), {
        headers: { "content-type": "application/json" },
      });
    },
  }),
);
const api = createTanstackQueryUtils(client);
let queryClient: QueryClient;
function mount() {
  current = thread();
  calls.length = 0;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CodeReviewsTab selectedId={id} onSelect={() => {}} />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  queryClient.clear();
  listFails = false;
  vi.useRealTimers();
});

describe("CodeReviewsTab comments", () => {
  it("gửi đúng payload tất cả thao tác và làm mới luồng sau mỗi lần ghi", async () => {
    mount();
    const user = {
      click: async (element: Element) => {
        await act(async () => {
          fireEvent.click(element);
        });
      },
      type: async (element: Element, value: string) => {
        fireEvent.change(element, { target: { value } });
      },
      clear: async (element: Element) => {
        fireEvent.change(element, { target: { value: "" } });
      },
    };
    await screen.findByText("Cần test");
    expect(calls.find((call) => call.path === "codeReviews/comments/list")?.input).toEqual({ reviewId: id });
    await user.click(screen.getByRole("button", { name: "Bình luận dòng 1 (mới)" }));
    await user.type(
      screen.getByRole("button", { name: "Thêm bình luận" }).closest("form")!.querySelector("textarea")!,
      "Góp ý mới",
    );
    await user.click(screen.getByRole("button", { name: "Thêm bình luận" }));
    await waitFor(() => expect(screen.getAllByLabelText("Nội dung bình luận")).toHaveLength(1));
    await user.type(screen.getByLabelText("Nội dung bình luận"), "Trả lời mới");
    await user.click(screen.getByRole("button", { name: "Trả lời" }));
    await user.click(screen.getByRole("button", { name: "Sửa bình luận" }));
    await user.clear(screen.getAllByLabelText("Nội dung bình luận")[0]!);
    await user.type(screen.getAllByLabelText("Nội dung bình luận")[0]!, "Sửa góp ý");
    await user.click(screen.getByRole("button", { name: "Lưu bình luận" }));
    await user.click(screen.getByRole("button", { name: "Đánh dấu đã xử lý" }));
    await user.click(await screen.findByRole("button", { name: "Mở lại luồng" }));
    await user.click(screen.getByRole("button", { name: "Xoá bình luận" }));
    await screen.findByText("Bình luận đã bị xoá");
    for (const [kind, input] of [
      ["add", { reviewId: id, path: "a.ts", line: 1, side: "new", headSha, body: "Góp ý mới" }],
      ["reply", { threadId: "t1", body: "Trả lời mới" }],
      ["edit", { commentId: "c1", body: "Sửa góp ý" }],
      ["delete", { commentId: "c1" }],
      ["resolve", { threadId: "t1" }],
      ["reopen", { threadId: "t1" }],
    ] as const)
      expect(calls.find((call) => call.path === `codeReviews/comments/${kind}`)?.input).toEqual(input);
    expect(calls.filter((call) => call.path === "codeReviews/comments/list").length).toBeGreaterThanOrEqual(7);
  });

  it("hỏi lại bình luận sau 30 giây", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    mount();
    await screen.findByText("Cần test");
    const before = calls.filter((call) => call.path === "codeReviews/comments/list").length;
    current.comments[0]!.body = "Bình luận từ PR";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(await screen.findByText("Bình luận từ PR")).toBeTruthy();
    expect(calls.filter((call) => call.path === "codeReviews/comments/list")).toHaveLength(before + 1);
  });

  it("tải bình luận lỗi vẫn xem diff và có thể tải lại", async () => {
    listFails = true;
    mount();
    await screen.findByRole("button", { name: "Tải lại" });
    expect(screen.getByRole("region", { name: "Patch của a.ts" })).toBeTruthy();
    listFails = false;
    fireEvent.click(screen.getByRole("button", { name: "Tải lại" }));
    expect(await screen.findByText("Cần test")).toBeTruthy();
  });
});
