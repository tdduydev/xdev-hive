import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ItemDetail } from "./item-detail.tsx";
import { latestRuns } from "./steps-panel.tsx";
import {
  autoApproval,
  fakeClient,
  itemDetail,
  PAYMENT,
  project,
  renderWithEnv,
  TEAM_BACKEND,
  testEnv,
  uuid,
  WEB,
} from "./test-fixtures.tsx";

const user = userEvent.setup({ delay: null });

function open(client = fakeClient(), tab?: Parameters<typeof ItemDetail>[0]["tab"]) {
  renderWithEnv(<ItemDetail projectKey="payment-api" number={12} tab={tab} />, testEnv(client));
  return client;
}

describe("latestRuns", () => {
  it("giữ lần chạy của vòng lớn nhất cho mỗi bước", () => {
    const step = itemDetail().steps[0];
    if (!step) throw new Error("thiếu bước");
    const later = { ...step, id: uuid(701), round: 2, status: "succeeded" as const };
    expect(latestRuns([later, step]).get("plan/draft-plan")?.round).toBe(2);
  });
});

describe("ItemDetail", () => {
  it("đầu trang, thanh giai đoạn và bước agent đang chờ máy", async () => {
    const client = open();
    expect(await screen.findByRole("heading", { level: 1, name: /Hoàn tiền một phần/ })).toBeTruthy();
    expect(client.sdlc.items.get).toHaveBeenCalledWith({ projectKey: "payment-api", number: 12 }, expect.anything());
    const stepper = screen.getByRole("list", { name: "Các giai đoạn của hạng mục" });
    expect(within(stepper).getByText("Plan").closest("li")?.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("Không máy nào có nhãn sdlc")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Chạy lại" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Tự duyệt bởi AI · 9,3/10")).toBeTruthy();
  });

  it("chạy đợt báo task đã chạy và task chưa chạy được", async () => {
    const client = open();
    await user.click(await screen.findByRole("button", { name: "Chạy đợt" }));
    expect(await screen.findByText(/Đã chạy 1 task; 1 task chưa chạy được/)).toBeTruthy();
    expect(screen.getByText("T-42: Chờ T-41 merge")).toBeTruthy();
    expect(client.sdlc.waves.run.mock.calls[0]?.[0]).toEqual({ id: itemDetail().id });
  });

  it("thu hồi tự duyệt cần lý do ít nhất 10 ký tự", async () => {
    const client = open();
    await user.click(await screen.findByRole("button", { name: "Thu hồi tự duyệt" }));
    const submit = screen.getAllByRole("button", { name: "Thu hồi tự duyệt" }).at(-1) as HTMLButtonElement;
    await user.type(screen.getByLabelText("Lý do"), "thiếu");
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText("Lý do"), " bước rollback");
    await user.click(submit);
    await waitFor(() =>
      expect(client.sdlc.autoApprovals.revoke.mock.calls[0]?.[0]).toEqual({
        id: autoApproval().id,
        reason: "thiếu bước rollback",
      }),
    );
  });

  it("tạo ngoại lệ theo dự án", async () => {
    const client = open();
    await user.click(await screen.findByRole("button", { name: "Tạo ngoại lệ" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "Một dự án" }));
    await user.selectOptions(within(dialog).getByLabelText("Dự án"), WEB.id);
    await user.type(within(dialog).getByLabelText("Lý do"), "Cần chạy thử trên staging");
    await user.click(within(dialog).getByRole("button", { name: "Tạo ngoại lệ" }));
    await waitFor(() =>
      expect(client.sdlc.overrides.create.mock.calls[0]?.[0]).toEqual({
        itemId: itemDetail().id,
        projectId: WEB.id,
        reason: "Cần chạy thử trên staging",
      }),
    );
  });

  it("tab Dự án: thêm dự án tham gia và bỏ dự án", async () => {
    const extra = project(4, "mobile-app", { teamId: TEAM_BACKEND });
    const client = fakeClient({ projects: [PAYMENT, WEB, extra] });
    open(client, "projects");
    expect(await screen.findByText("Backend")).toBeTruthy();
    await user.selectOptions(await screen.findByLabelText("Dự án"), extra.id);
    await user.click(screen.getByRole("button", { name: "Thêm dự án" }));
    await waitFor(() =>
      expect(client.sdlc.items.projects.add.mock.calls[0]?.[0]).toEqual({ id: itemDetail().id, projectId: extra.id }),
    );
    await user.click(screen.getByRole("button", { name: "Bỏ dự án: web-shop" }));
    await waitFor(() =>
      expect(client.sdlc.items.projects.remove.mock.calls[0]?.[0]).toEqual({ id: itemDetail().id, projectId: WEB.id }),
    );
  });

  it("tab Tài liệu: trạng thái đồng bộ theo repo, thử lại repo lỗi", async () => {
    const client = open(fakeClient(), "docs");
    expect(await screen.findByText("Không có quyền ghi repo")).toBeTruthy();
    expect(screen.getByText("Đã đồng bộ")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    await waitFor(() =>
      expect(client.sdlc.sync.mock.calls[0]?.[0]).toEqual({ id: itemDetail().id, projectId: WEB.id, action: "retry" }),
    );
  });

  it("tab Contract: bên cung cấp, bên dùng và thêm contract", async () => {
    const client = open(fakeClient(), "contracts");
    expect(await screen.findByText("refund-api")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mở bản duyệt contract" })).toBeTruthy();
    await user.type(screen.getByLabelText("Tên contract"), "stock-events");
    await user.selectOptions(screen.getByLabelText("Định dạng"), "asyncapi");
    await user.click(screen.getByRole("checkbox", { name: "web-shop" }));
    await user.click(screen.getByRole("button", { name: "Thêm contract" }));
    await waitFor(() =>
      expect(client.sdlc.contracts.create.mock.calls[0]?.[0]).toEqual({
        itemId: itemDetail().id,
        name: "stock-events",
        format: "asyncapi",
        providerProjectId: PAYMENT.id,
        consumerProjectIds: [WEB.id],
      }),
    );
  });

  it("tab Task: theo đợt, ghi task chặn ở dự án khác", async () => {
    open(fakeClient(), "tasks");
    expect(await screen.findByRole("heading", { name: "Đợt 2" })).toBeTruthy();
    expect(screen.getByText("Bị chặn bởi payment-api T-41")).toBeTruthy();
    expect(screen.getAllByText("Checklist 1/1")).toHaveLength(2);
  });

  it("tab Task chuyển sang bản tách, tab Truy vết hiện ma trận", async () => {
    const client = open(fakeClient(), "tasks");
    await user.click(await screen.findByRole("button", { name: "Bản tách" }));
    expect(await screen.findByText("Chưa có task: FR-003")).toBeTruthy();
    expect(client.sdlc.breakdown.get).toHaveBeenCalled();
    cleanup();
    open(client, "trace");
    expect(await screen.findByText("Ma trận yêu cầu")).toBeTruthy();
  });

  it("người chỉ đọc không thấy thao tác", async () => {
    const can = {
      write: false,
      manage: false,
      override: false,
      runWaves: false,
      editProjects: false,
      changeMode: false,
    };
    open(fakeClient({ item: itemDetail({ can, autoApprovals: [autoApproval({ canRevoke: false })] }) }));
    expect(await screen.findByText("Chỉ đọc")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Chạy đợt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tạo ngoại lệ" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Thu hồi tự duyệt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Chạy lại" })).toBeNull();
  });

  it("báo lỗi tải và thử lại", async () => {
    const client = fakeClient();
    client.sdlc.items.get.mockRejectedValueOnce(new Error("Không tìm thấy hạng mục."));
    open(client);
    expect(await screen.findByText("Không tìm thấy hạng mục.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(await screen.findByRole("heading", { level: 1, name: /Hoàn tiền một phần/ })).toBeTruthy();
  });
});
