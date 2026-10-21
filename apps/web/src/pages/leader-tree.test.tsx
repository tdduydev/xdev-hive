// @vitest-environment jsdom
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Contract, DelegationTree } from "@xdev-hive/contracts";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TreeLinks } from "@/components/tree-links.tsx";
import { LeaderTree } from "@/pages/leader-tree.tsx";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({
    to,
    search,
    children,
    className,
  }: {
    to: string;
    search: object;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={`${to}?${new URLSearchParams(search as Record<string, string>)}`} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("@/shell/org-context.ts", () => ({ useOrg: () => ({ api, org: { id: "org-1" } }) }));

const THREAD_ID = "4d4d4d4d-0000-4000-8000-000000000001";
const RUN_ID = "7a7a7a7a-0000-4000-8000-000000000001";
const TASK_ID = "6b6b6b6b-0000-4000-8000-000000000001";

const TREE: DelegationTree = {
  thread: { id: THREAD_ID, title: "Phân quyền menu", createdAt: "2026-10-21T00:00:00.000Z" },
  hidden: 1,
  active: false,
  tasks: [
    {
      id: TASK_ID,
      key: "PAY-1",
      title: "Bảng quyền",
      status: "running",
      projectKey: "PAY",
      createdBy: "leader",
      runs: [
        {
          id: RUN_ID,
          kind: "code",
          state: "failed",
          attempt: 2,
          parentRunId: null,
          machine: { id: "8e8e8e8e-0000-4000-8000-000000000001", name: "mac-ha" },
          cli: "claude",
          account: "Pro",
          startedAt: "2026-10-21T01:00:00.000Z",
          endedAt: "2026-10-21T01:02:00.000Z",
          costUsd: 0.3,
          error: "Test hỏng",
          subagents: [],
          subagentsUnsupported: false,
        },
      ],
    },
  ],
};

let replies: Record<string, () => Response>;
const calls: { path: string; input: unknown }[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify({ json: value }), { status, headers: { "content-type": "application/json" } });

const client: ContractRouterClient<Contract> = createORPCClient(
  new RPCLink({
    url: "http://test/rpc",
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname.replace("/rpc/", "");
      calls.push({ path, input: (await request.json()).json });
      const reply = replies[path];
      return reply ? reply() : json({ defined: false, code: "NOT_FOUND", status: 404, message: "x" }, 404);
    },
  }),
);
const api = createTanstackQueryUtils(client);

const mount = (node: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {node}
    </QueryClientProvider>,
  );

beforeEach(() => {
  calls.length = 0;
  navigate.mockReset();
  replies = { "leader/tree/get": () => json(TREE) };
});
afterEach(cleanup);

describe("LeaderTree", () => {
  it("vẽ cây của phiên và mở trang run khi bấm nút run", async () => {
    mount(<LeaderTree threadId={THREAD_ID} />);
    const tree = await screen.findByRole("tree", { name: "Cây giao việc: Phân quyền menu" });
    expect(calls[0]).toEqual({ path: "leader/tree/get", input: { id: THREAD_ID } });
    expect(screen.getByText("1 mục bị ẩn do quyền")).toBeTruthy();
    const run = within(tree).getByRole("treeitem", { name: "Run Viết code, Lỗi, máy mac-ha" });
    expect(run.textContent).toContain("Test hỏng");
    expect(run.textContent).toContain("lần thử 2");
    expect(run.textContent).toContain("2 phút");
    fireEvent.click(within(run).getByRole("button", { name: "Viết code" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/runs/$id", params: { id: RUN_ID } });
  });

  it("hub lỗi thì báo lỗi, không vẽ cây", async () => {
    replies = { "leader/tree/get": () => json({ defined: false, code: "FORBIDDEN", status: 403, message: "x" }, 403) };
    mount(<LeaderTree threadId={THREAD_ID} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("tree")).toBeNull();
  });
});

describe("TreeLinks", () => {
  it("không thuộc phiên Leader nào thì không hiện gì", async () => {
    replies = { "leader/tree/links": () => json([]) };
    const { container } = mount(<TreeLinks runId={RUN_ID} />);
    await vi.waitFor(() => expect(calls).toEqual([{ path: "leader/tree/links", input: { runId: RUN_ID } }]));
    expect(container.textContent).toBe("");
  });

  it("một phiên thì là liên kết thẳng tới tab cây", async () => {
    replies = { "leader/tree/links": () => json([{ threadId: THREAD_ID, title: "Phân quyền menu" }]) };
    mount(<TreeLinks taskId={TASK_ID} />);
    const link = await screen.findByRole("link", { name: "Xem trong cây giao việc" });
    expect(link.getAttribute("href")).toBe(`/leader?thread=${THREAD_ID}&view=tree`);
    expect(calls[0]?.input).toEqual({ taskId: TASK_ID });
  });

  it("nhiều phiên thì chọn trong menu", async () => {
    const other = "4d4d4d4d-0000-4000-8000-000000000002";
    replies = {
      "leader/tree/links": () =>
        json([
          { threadId: THREAD_ID, title: "Phân quyền menu" },
          { threadId: other, title: "Sửa lỗi thanh toán" },
        ]),
    };
    mount(<TreeLinks taskId={TASK_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Xem trong cây giao việc" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sửa lỗi thanh toán" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/leader", search: { thread: other, view: "tree" } });
  });
});
