import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SDLC_PHASE_KINDS } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { ItemBoard } from "./item-board.tsx";
import { fakeClient, PAYMENT, renderWithEnv, summary, testEnv, WEB } from "./test-fixtures.tsx";

const user = userEvent.setup({ delay: null });

const multi = summary(12, {
  projects: [
    { id: PAYMENT.id, key: PAYMENT.key, name: PAYMENT.name, role: "home" },
    { id: WEB.id, key: WEB.key, name: WEB.name, role: "participant" },
  ],
  openQuestions: 2,
});
const machine = summary(9, {
  kind: "implementation",
  title: "Sửa lỗi làm tròn",
  waitingFor: null,
  waitingMachine: true,
  owner: { userId: "u2", name: "Phạm Hà" },
});
const columns = SDLC_PHASE_KINDS.map((kind) => ({
  kind,
  items: [multi, machine].filter((i) => i.phase?.kind === kind),
}));

describe("ItemBoard", () => {
  it("dựng bảy cột theo giai đoạn chuẩn, thẻ có chip dự án, đang chờ và câu hỏi", async () => {
    renderWithEnv(<ItemBoard />, testEnv(fakeClient({ columns })));
    const board = await screen.findByRole("region", { name: "Bảng hạng mục theo giai đoạn" });
    expect(within(board).getAllByRole("heading", { level: 2 })).toHaveLength(7);
    const requirements = within(board).getByRole("region", { name: /Yêu cầu/ });
    expect(within(requirements).getByText(/Hoàn tiền một phần/)).toBeTruthy();
    expect(within(requirements).getByText("web-shop")).toBeTruthy();
    expect(within(requirements).getByText("Chờ An (PO) · quá hạn 3 giờ")).toBeTruthy();
    expect(within(requirements).getByText("Chờ trả lời (2)")).toBeTruthy();
    expect(screen.getByText("Chờ máy AI SDLC")).toBeTruthy();
    expect(screen.getByText("2 hạng mục")).toBeTruthy();
  });

  it("lọc dự án gửi hub và đánh dấu chip khớp; lọc người lọc tại chỗ", async () => {
    const client = fakeClient({ columns });
    renderWithEnv(<ItemBoard />, testEnv(client));
    await screen.findByText(/Hoàn tiền một phần/);
    await user.selectOptions(screen.getByLabelText("Dự án"), WEB.id);
    await waitFor(() => expect(client.sdlc.board).toHaveBeenLastCalledWith({ projectId: WEB.id }, expect.anything()));
    expect((await screen.findByTitle("web-shop")).textContent).toBe("✓ web-shop");

    await user.selectOptions(screen.getByLabelText("Người"), "u2");
    expect(screen.queryByText(/Hoàn tiền một phần/)).toBeNull();
    expect(screen.getByText(/Sửa lỗi làm tròn/)).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Xoá bộ lọc" })[0] as HTMLElement);
    expect(await screen.findByText(/Hoàn tiền một phần/)).toBeTruthy();
  });

  it("dạng danh sách hiện bảng có cột giai đoạn", async () => {
    renderWithEnv(<ItemBoard initialView="list" />, testEnv(fakeClient({ columns })));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Triển khai")).toBeTruthy();
    expect(within(table).getByText("012-hoan-tien-mot-phan")).toBeTruthy();
  });

  it("rỗng khi chưa dự án nào bật AI SDLC, và khi chưa có hạng mục", async () => {
    const off = fakeClient({ projects: [{ ...PAYMENT, settings: { ...PAYMENT.settings, sdlc: undefined } }] });
    const { unmount } = renderWithEnv(<ItemBoard />, testEnv(off));
    expect(await screen.findByText("Chưa dự án nào bật AI SDLC")).toBeTruthy();
    unmount();
    renderWithEnv(<ItemBoard />, testEnv(fakeClient()));
    expect(await screen.findByText("Chưa có hạng mục nào")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Tạo hạng mục đầu tiên" })).toBeTruthy();
  });

  it("người chỉ đọc không thấy nút tạo", async () => {
    renderWithEnv(
      <ItemBoard />,
      testEnv(fakeClient({ columns }), { can: { write: () => false, override: false, manageModes: false } }),
    );
    await screen.findByText(/Hoàn tiền một phần/);
    expect(screen.getByText("Chỉ đọc")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Tạo hạng mục" })).toBeNull();
  });

  it("báo lỗi tải và thử lại", async () => {
    const client = fakeClient({ columns });
    client.sdlc.board.mockRejectedValueOnce(new Error("Hub không trả lời"));
    renderWithEnv(<ItemBoard />, testEnv(client));
    expect(await screen.findByText("Hub không trả lời")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(await screen.findByText(/Hoàn tiền một phần/)).toBeTruthy();
  });
});
