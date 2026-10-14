import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { allowedModes, NewItem } from "./new-item.tsx";
import { fakeClient, PAYMENT, RECONCILE, renderWithEnv, TEAM_WEB, testEnv, WEB } from "./test-fixtures.tsx";

const user = userEvent.setup({ delay: null });
const IDEA = "Cho phép hoàn tiền một phần cho giao dịch thẻ và chuyển khoản.";

async function fill() {
  await user.selectOptions(await screen.findByLabelText("Dự án chính"), PAYMENT.id);
  await user.type(screen.getByLabelText("Tiêu đề"), "Hoàn tiền một phần");
  await user.type(screen.getByLabelText("Ý tưởng"), IDEA);
}

describe("allowedModes", () => {
  it("rỗng là chỉ chế độ mặc định", () => {
    expect(allowedModes({ defaultMode: "small", modes: [] })).toEqual(["small"]);
    expect(allowedModes({ defaultMode: "small", modes: ["speckit", "bugfix"] })).toEqual(["speckit", "bugfix"]);
    expect(allowedModes(undefined)).toEqual([]);
  });
});

describe("NewItem", () => {
  it("nhận gợi ý cỡ và chế độ rồi tạo hạng mục nhiều dự án", async () => {
    const client = fakeClient();
    renderWithEnv(<NewItem />, testEnv(client));
    await fill();
    await user.click(screen.getByRole("checkbox", { name: /web-shop/ }));
    expect(await screen.findByText("Đụng thanh toán, nhiều màn → L → Spec Kit", {}, { timeout: 3000 })).toBeTruthy();
    expect((screen.getByLabelText("Cỡ việc") as HTMLSelectElement).value).toBe("L");
    expect((screen.getByLabelText("Chế độ") as HTMLSelectElement).value).toBe("speckit");
    expect(screen.getByText("hoan-tien-mot-phan")).toBeTruthy();
    expect(screen.getByText("specs/NNN-hoan-tien-mot-phan/")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Tạo hạng mục" }));
    await waitFor(() => expect(client.sdlc.items.create).toHaveBeenCalled());
    expect(client.sdlc.items.create.mock.calls[0]?.[0]).toMatchObject({
      projectId: PAYMENT.id,
      participants: [WEB.id],
      title: "Hoàn tiền một phần",
      modeRef: "speckit",
      size: "L",
      suggestion: { size: "L", modeRef: "speckit" },
    });
    expect(await screen.findByText("Đã tạo hạng mục")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mở hạng mục" })).toBeTruthy();
  });

  it("khoá dự án chưa bật AI SDLC và ẩn dự án không có quyền ghi", async () => {
    const env = testEnv(fakeClient(), {
      can: { write: (teamId) => teamId !== TEAM_WEB, override: false, manageModes: false },
    });
    renderWithEnv(<NewItem />, env);
    const primary = await screen.findByLabelText("Dự án chính");
    const reconcile = within(primary).getByRole("option", { name: /reconcile/ }) as HTMLOptionElement;
    expect(reconcile.disabled).toBe(true);
    expect(within(primary).queryByRole("option", { name: "web-shop" })).toBeNull();
    await user.selectOptions(primary, PAYMENT.id);
    expect((screen.getByRole("checkbox", { name: new RegExp(RECONCILE.key) }) as HTMLInputElement).disabled).toBe(true);
  });

  it("chế độ dự án không cho dùng bị khoá; lỗi hub hiện lại và giữ nội dung", async () => {
    const client = fakeClient();
    client.sdlc.items.create.mockRejectedValueOnce(new Error("Bạn không có quyền sdlc.write ở web-shop."));
    const onCreated = vi.fn();
    renderWithEnv(<NewItem onCreated={onCreated} />, testEnv(client));
    await fill();
    const mode = screen.getByLabelText("Chế độ");
    await waitFor(() =>
      expect((within(mode).getByRole("option", { name: /Việc nhỏ|Small/ }) as HTMLOptionElement).disabled).toBe(true),
    );
    await screen.findByText("Đụng thanh toán, nhiều màn → L → Spec Kit", {}, { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "Tạo hạng mục" }));
    expect(await screen.findByText("Bạn không có quyền sdlc.write ở web-shop.")).toBeTruthy();
    expect((screen.getByLabelText("Tiêu đề") as HTMLInputElement).value).toBe("Hoàn tiền một phần");
    await user.click(screen.getByRole("button", { name: "Tạo hạng mục" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("người chỉ đọc không gửi được", async () => {
    renderWithEnv(
      <NewItem />,
      testEnv(fakeClient(), { can: { write: () => false, override: false, manageModes: false } }),
    );
    expect(await screen.findByText("Chưa có dự án nào để tạo hạng mục")).toBeTruthy();
    expect(screen.getByText("Chỉ đọc")).toBeTruthy();
  });
});
