// @vitest-environment jsdom
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Contract, DocSummary, Project } from "@xdev-hive/contracts";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocsPage } from "@/pages/knowledge/docs-page.tsx";

vi.mock("@/shell/org-context.ts", () => ({ useOrg: () => ({ api, org: { id: "org-a", role: "member" } }) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

const TEAM_ID = "00000000-0000-4000-8000-000000000001";
const SYSTEM_ID = "00000000-0000-4000-8000-000000000002";
const PROJECT_ID = "00000000-0000-4000-8000-000000000003";
const at = "2026-10-17T03:00:00.000Z";
const doc: DocSummary = {
  id: "doc-a",
  key: "project/refund/guide",
  title: "Hướng dẫn hoàn tiền",
  scope: { level: "project", teamId: TEAM_ID, projectId: PROJECT_ID },
  version: 1,
  updatedAt: at,
  updatedBy: { userId: null, runId: null },
};
const replies: Record<string, unknown> = {
  "docs/list": [doc],
  "docTree/list": { items: [], nextCursor: null },
  "projectMembers/mine": { projectIds: [PROJECT_ID], teamIds: [TEAM_ID] },
  "teams/list": [{ id: TEAM_ID, slug: "pay", name: "Khối Thanh toán", color: null, createdAt: at }],
  "systems/list": [
    { id: SYSTEM_ID, teamId: TEAM_ID, slug: "refund", name: "Hệ thống hoàn tiền", description: null, createdAt: at },
  ],
  "projects/list": [{ id: PROJECT_ID, systemId: SYSTEM_ID, teamId: TEAM_ID, name: "Cổng hoàn tiền" } as Project],
};
/** Đường dẫn RPC đang trả lỗi 500. */
let failing: Set<string>;
const calls: string[] = [];
const client: ContractRouterClient<Contract> = createORPCClient(
  new RPCLink({
    url: "http://test/rpc",
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname.replace("/rpc/", "");
      calls.push(path);
      const reply = (value: unknown, status = 200) =>
        new Response(JSON.stringify({ json: value }), { status, headers: { "content-type": "application/json" } });
      if (failing.has(path)) {
        return reply({ defined: false, code: "INTERNAL_SERVER_ERROR", status: 500, message: "Internal" }, 500);
      }
      if (path in replies) return reply(replies[path]);
      throw new Error(`Lời gọi ngoài dự kiến: ${path}`);
    },
  }),
);
const api = createTanstackQueryUtils(client, { path: ["org", "org-a"] });
let cache: QueryClient;
function mount() {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cache}>
      <DocsPage />
    </QueryClientProvider>,
  );
}
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

beforeEach(() => {
  failing = new Set();
  calls.length = 0;
});
afterEach(() => {
  cleanup();
  cache.clear();
});

describe("DocsPage khi không tải được danh mục", () => {
  it("báo lỗi, vẫn hiện cây với tên tạm, Tải lại chỉ gọi lại phần lỗi", async () => {
    failing = new Set(["teams/list", "projectMembers/mine"]);
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Hub đang gặp lỗi");
    // Hai lời gọi lỗi gộp vào một thông báo.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Mở nhóm Đơn vị khác" })).toBeTruthy();
    // Chưa biết mình thuộc dự án nào thì trang mở "Tất cả".
    expect(pressed("Tất cả")).toBe("true");

    failing.clear();
    const before = calls.length;
    fireEvent.click(within(alert).getByRole("button", { name: "Tải lại" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(calls.slice(before).sort()).toEqual(["projectMembers/mine", "teams/list"]);
    expect(screen.getByRole("button", { name: "Thu nhóm Khối Thanh toán" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Thu nhóm Cổng hoàn tiền" })).toBeTruthy();
    expect(pressed("Dự án của tôi")).toBe("true");
  });

  it("thiếu hệ thống thì dự án nằm ở Dự án khác, thử lại vẫn lỗi thì còn báo lỗi", async () => {
    failing = new Set(["systems/list"]);
    mount();
    const alert = await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Mở nhóm Khối Thanh toán" }));
    expect(screen.getByRole("button", { name: "Mở nhóm Dự án khác" })).toBeTruthy();

    fireEvent.click(within(alert).getByRole("button", { name: "Tải lại" }));
    await waitFor(() => expect(calls.filter((path) => path === "systems/list")).toHaveLength(2));
    expect(screen.getByRole("alert").textContent).toContain("Hub đang gặp lỗi");
  });
});
