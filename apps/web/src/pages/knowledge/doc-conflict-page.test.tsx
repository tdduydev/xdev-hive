// @vitest-environment jsdom
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Contract, DocConflictDetail, DocExtract } from "@xdev-hive/contracts";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocConflictPage } from "@/pages/knowledge/doc-conflict-page.tsx";
import { DocExtractsPage } from "@/pages/knowledge/doc-extracts-page.tsx";

vi.mock("@/shell/org-context.ts", () => ({ useOrg: () => ({ api, org: { id: "org-a" } }) }));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ id: "conflict-a" }),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

const at = "2026-10-15T03:00:00.000Z";
let conflict: DocConflictDetail;
let extract: DocExtract;
let stale: boolean;
let forbidden: boolean;
const calls: { path: string; input: Record<string, unknown> }[] = [];
const client: ContractRouterClient<Contract> = createORPCClient(
  new RPCLink({
    url: "http://test/rpc",
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname.replace("/rpc/", "");
      const input = (await request.json()).json as Record<string, unknown>;
      calls.push({ path, input });
      const reply = (value: unknown, status = 200) =>
        new Response(JSON.stringify({ json: value }), { status, headers: { "content-type": "application/json" } });
      if (forbidden)
        return reply(
          { defined: true, code: "FORBIDDEN", status: 403, message: "Bạn không có quyền quản lý tài liệu này." },
          403,
        );
      if (path === "docConflicts/get") return reply(conflict);
      if (path === "docConflicts/resolve") {
        if (stale) {
          stale = false;
          // Sửa tài liệu hub không cập nhật timestamp của hàng xung đột.
          conflict = { ...conflict, hubVersion: 3, hubContent: "# Bản hub mới" };
          return reply(
            {
              defined: true,
              code: "CONFLICT",
              status: 409,
              message: "Tài liệu vừa đổi.",
              data: { code: "VERSION_CONFLICT" },
            },
            409,
          );
        }
        conflict = { ...conflict, state: "resolved", resolution: input.choice as "hub", resolvedVersion: 4 };
        return reply({ key: conflict.key, version: 4 });
      }
      if (path === "docExtracts/list") return reply({ items: [extract], nextCursor: null });
      if (path === "docExtracts/get") return reply(extract);
      if (path === "docExtracts/update") {
        extract = { ...extract, content: input.content as string, updatedAt: "2026-10-15T04:00:00.000Z" };
        return reply(extract);
      }
      if (path === "docExtracts/approve") {
        extract = { ...extract, state: "approved", updatedAt: "2026-10-15T05:00:00.000Z" };
        return reply(extract);
      }
      throw new Error(`Lời gọi ngoài dự kiến: ${path}`);
    },
  }),
);
const api = createTanstackQueryUtils(client, { path: ["org", "org-a"] });
let cache: QueryClient;
function mount(page: ReactNode) {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={cache}>{page}</QueryClientProvider>);
}
beforeEach(() => {
  calls.length = 0;
  stale = false;
  forbidden = false;
  conflict = {
    id: "conflict-a",
    homeId: "home-a",
    docId: "doc-a",
    key: "org/guide",
    title: "Hướng dẫn",
    repoPath: "docs/guide.md",
    baseVersion: 1,
    hubVersion: 2,
    repoCommit: "a".repeat(40),
    origin: "repo",
    state: "open",
    resolution: null,
    resolvedVersion: null,
    createdAt: at,
    updatedAt: at,
    baseContent: "# Gốc",
    hubContent: "# Hub",
    repoContent: "# Repo",
    merge: { content: "# Hub", conflicts: 1 },
  };
  extract = {
    id: "extract-a",
    assetId: "asset-a",
    homeId: "home-a",
    repoPath: "docs/guide.pdf",
    sourceSha256: "b".repeat(64),
    state: "review",
    secretFlag: false,
    error: null,
    warnings: [],
    reviewedBy: null,
    reviewedAt: null,
    createdAt: at,
    updatedAt: at,
    content: "# Bản trích",
    findings: [],
  };
});
afterEach(() => {
  cleanup();
  cache.clear();
});

describe("DocConflictPage", () => {
  it("tải lại hubVersion mới dù timestamp xung đột không đổi, rồi gửi đúng phiên bản", async () => {
    stale = true;
    mount(<DocConflictPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Giữ bản repo" }));
    const reload = await screen.findByRole("button", { name: "Tải bản mới nhất" });
    expect((screen.getByRole("button", { name: "Giữ bản hub" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(reload);
    await screen.findByText("# Bản hub mới");
    const keep = screen.getByRole("button", { name: "Giữ bản hub" });
    await waitFor(() => expect((keep as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(keep);
    await screen.findByText("Xung đột này đã được giải quyết.");
    expect(calls.filter((call) => call.path === "docConflicts/resolve").map((call) => call.input)).toEqual([
      { id: "conflict-a", choice: "repo", baseVersion: 2 },
      { id: "conflict-a", choice: "hub", baseVersion: 3 },
    ]);
  });

  it("không hiện nội dung khi API từ chối quyền", async () => {
    forbidden = true;
    mount(<DocConflictPage />);
    await screen.findByText("Bạn không có quyền quản lý tài liệu này.");
    expect(screen.queryByText("# Hub")).toBeNull();
    expect(screen.queryByRole("button", { name: "Giữ bản hub" })).toBeNull();
  });
});

describe("DocExtractsPage", () => {
  it("chặn duyệt khi có sửa chưa lưu, gửi mốc cập nhật mới sau khi lưu", async () => {
    mount(<DocExtractsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /docs\/guide.pdf/ }));
    const content = await screen.findByLabelText("Nội dung bản trích (Markdown)");
    fireEvent.change(content, { target: { value: "# Nội dung đã kiểm tra" } });
    expect((screen.getByRole("button", { name: "Duyệt bản trích" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Lưu bản trích" }));
    await screen.findByText("Đã lưu bản trích.");
    fireEvent.click(screen.getByRole("button", { name: "Duyệt bản trích" }));
    await screen.findByText("Đã duyệt bản trích.");
    expect(calls.find((call) => call.path === "docExtracts/update")?.input).toEqual({
      id: "extract-a",
      content: "# Nội dung đã kiểm tra",
      updatedAt: at,
    });
    expect(calls.find((call) => call.path === "docExtracts/approve")?.input).toEqual({
      id: "extract-a",
      updatedAt: "2026-10-15T04:00:00.000Z",
    });
    expect((screen.getByLabelText("Nội dung bản trích (Markdown)") as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it("bản có dấu hiệu bí mật chỉ hiện loại và dòng trong cảnh báo, chặn duyệt", async () => {
    extract.secretFlag = true;
    extract.findings = [{ kind: "github_token", line: 12 }];
    mount(<DocExtractsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /docs\/guide.pdf/ }));
    await screen.findByText("dòng 12 (GitHub token)");
    expect((screen.getByRole("button", { name: "Duyệt bản trích" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("link", { name: "Xem file gốc" }).getAttribute("href")).toBe(
      "/api/v1/docs/assets/asset-a?org=org-a",
    );
    expect(calls.some((call) => call.path === "docExtracts/approve")).toBe(false);
  });
});
