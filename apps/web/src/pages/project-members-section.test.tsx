// @vitest-environment jsdom
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Contract, Project, ProjectMember } from "@xdev-hive/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectMembersSection } from "@/pages/project-members-section.tsx";

vi.mock("@/shell/org-context.ts", () => ({ useOrg: () => ({ api, org: { id: "org-1" } }) }));

const TEAM_ID = "00000000-0000-4000-8000-000000000001";
const project = { id: "00000000-0000-4000-8000-000000000009", teamId: TEAM_ID, key: "PAY" } as Project;
const at = "2026-10-11T07:10:00.000Z";
const person = (userId: string, name: string) => ({ userId, name, email: `${userId}@acme.vn`, image: null });
const teamMembers = [
  { ...person("u-lan", "Trần Lan"), teamId: TEAM_ID, role: "member" },
  { ...person("u-ha", "Phạm Hà"), teamId: TEAM_ID, role: "member" },
  { ...person("u-binh", "Lê Bình"), teamId: TEAM_ID, role: "admin" },
];

let members: ProjectMember[];
/** Đặt để lần thêm kế tiếp bị hub từ chối với câu này. */
let addRejection: string | null;
const calls: { path: string; input: Record<string, unknown> }[] = [];

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify({ json: value }), { status, headers: { "content-type": "application/json" } });

const client: ContractRouterClient<Contract> = createORPCClient(
  new RPCLink({
    url: "http://test/rpc",
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname.replace("/rpc/", "");
      const input = (await request.json()).json as Record<string, unknown>;
      calls.push({ path, input });
      if (path === "teamMembers/list") return json(teamMembers);
      if (path === "projectMembers/list") return json(members);
      if (path === "projectMembers/add") {
        if (addRejection) {
          return json({ defined: true, code: "PROJECT_MEMBER_NOT_IN_TEAM", status: 400, message: addRejection }, 400);
        }
        const wanted = input.userIds as string[];
        members = [
          ...members,
          ...teamMembers
            .filter((m) => wanted.includes(m.userId))
            .map((m) => ({ ...m, addedBy: "u1", addedAt: at }) satisfies ProjectMember),
        ];
        return json(members);
      }
      if (path === "projectMembers/remove") {
        members = members.filter((m) => m.userId !== input.userId);
        return json({ ok: true });
      }
      return json(null, 404);
    },
  }),
);
const api = createTanstackQueryUtils(client);

function mount(canManage: boolean) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ProjectMembersSection project={project} canManage={canManage} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  members = [{ ...person("u-lan", "Trần Lan"), addedBy: "u1", addedAt: at }];
  addRejection = null;
  calls.length = 0;
});
afterEach(cleanup);

describe("ProjectMembersSection", () => {
  it("quản trị đội thấy Thêm và Gỡ, chọn hai người rồi thêm thì gửi đúng hai userId", async () => {
    mount(true);
    const list = await screen.findByRole("list", { name: "Thành viên dự án" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("u-lan@acme.vn")).toBeTruthy();
    expect(within(list).getByRole("button", { name: "Gỡ" })).toBeTruthy();

    // Người đã ở trong dự án không còn trong danh sách để chọn.
    expect(screen.queryByRole("checkbox", { name: /Trần Lan/ })).toBeNull();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Phạm Hà/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Lê Bình/ }));
    fireEvent.click(screen.getByRole("button", { name: "Thêm" }));

    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    const add = calls.find((c) => c.path === "projectMembers/add");
    expect(add?.input).toEqual({ id: project.id, userIds: ["u-ha", "u-binh"] });
  });

  it("nút Thêm khoá khi chưa chọn ai", async () => {
    mount(true);
    await screen.findByRole("checkbox", { name: /Phạm Hà/ });
    expect((screen.getByRole("button", { name: "Thêm" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("bấm Gỡ thì gọi remove với userId của dòng đó", async () => {
    mount(true);
    const list = await screen.findByRole("list", { name: "Thành viên dự án" });
    fireEvent.click(within(list).getByRole("button", { name: "Gỡ" }));
    // Hết người thì danh sách được thay bằng dòng báo trống.
    expect(await screen.findByText("Dự án chưa có thành viên.")).toBeTruthy();
    expect(calls.find((c) => c.path === "projectMembers/remove")?.input).toEqual({
      id: project.id,
      userId: "u-lan",
    });
  });

  it("thành viên thường chỉ xem danh sách, không có Thêm, Gỡ hay ô chọn", async () => {
    mount(false);
    const list = await screen.findByRole("list", { name: "Thành viên dự án" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Thêm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Gỡ" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // Không có quyền quản lý thì hub cũng không cần danh sách đội.
    expect(calls.some((c) => c.path === "teamMembers/list")).toBe(false);
  });

  it("hiện câu lỗi của hub khi thêm người ngoài đội", async () => {
    addRejection = "Lê Bình chưa thuộc đội. Thêm người này vào đội trước.";
    mount(true);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Lê Bình/ }));
    fireEvent.click(screen.getByRole("button", { name: "Thêm" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Lê Bình chưa thuộc đội");
  });
});
