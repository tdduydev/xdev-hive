import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BreakdownReview } from "./breakdown-review.tsx";
import { breakdownView, fakeClient, itemDetail, renderWithEnv, testEnv } from "./test-fixtures.tsx";

const user = userEvent.setup({ delay: null });

function open(client = fakeClient(), item = itemDetail()) {
  renderWithEnv(<BreakdownReview item={item} />, testEnv(client));
  return client;
}

const card = (key: string) => {
  const li = screen
    .getAllByRole("listitem")
    .find((el) => el.querySelector(".font-mono")?.textContent === key && el.querySelector("select"));
  if (!li) throw new Error(`không thấy thẻ ${key}`);
  return li;
};

describe("BreakdownReview", () => {
  it("tóm tắt, phụ thuộc liên dự án và requirement chưa có task", async () => {
    const client = open();
    expect(await screen.findByLabelText("Tóm tắt bản tách")).toBeTruthy();
    expect(client.sdlc.breakdown.get.mock.calls[0]?.[0]).toEqual({ id: itemDetail().id, source: "draft" });
    expect(screen.getByText("Chưa có task: FR-003")).toBeTruthy();
    expect(screen.getByText("2/3 requirement có task (67%)")).toBeTruthy();
    expect(within(card("T003")).getByText("(liên dự án)")).toBeTruthy();
  });

  it("gộp T002 vào T001 rồi lưu kèm revision đã đọc", async () => {
    const client = open();
    await screen.findByText("Task trong bản tách");
    const save = screen.getByRole("button", { name: "Lưu bản nháp" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText("Task đích cho T002"), "T001");
    await user.click(within(card("T002")).getByRole("button", { name: "Gộp vào" }));
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(client.sdlc.breakdown.save).toHaveBeenCalled());
    const input = client.sdlc.breakdown.save.mock.calls[0]?.[0];
    expect(input?.baseRevision).toBe(3);
    expect(input?.breakdown?.tasks.map((t) => t.sliceKey)).toEqual(["T001", "T003"]);
    expect(input?.breakdown?.tasks[1]?.dependsOn).toEqual(["T001"]);
  });

  it("phụ thuộc tạo chu trình bị từ chối và chỉ rõ vòng", async () => {
    open();
    await screen.findByText("Task trong bản tách");
    await user.selectOptions(screen.getByLabelText("Thêm phụ thuộc cho T001"), "T003");
    await user.click(within(card("T001")).getByRole("button", { name: "Thêm phụ thuộc" }));
    expect(await screen.findByText("Không thêm được phụ thuộc: chu trình")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Lưu bản nháp" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("đổi dự án của task và bỏ phụ thuộc", async () => {
    const client = open();
    await screen.findByText("Task trong bản tách");
    await user.selectOptions(screen.getByLabelText("Dự án T003"), "payment-api");
    await user.click(screen.getByRole("button", { name: "Bỏ phụ thuộc T001 của T002" }));
    await user.click(screen.getByRole("button", { name: "Lưu bản nháp" }));
    await waitFor(() => expect(client.sdlc.breakdown.save).toHaveBeenCalled());
    const tasks = client.sdlc.breakdown.save.mock.calls[0]?.[0]?.breakdown?.tasks ?? [];
    expect(tasks.find((t) => t.sliceKey === "T003")?.project).toBe("payment-api");
    expect(tasks.find((t) => t.sliceKey === "T002")?.dependsOn).toEqual([]);
  });

  it("người chỉ đọc không thấy thao tác sửa", async () => {
    open(fakeClient(), itemDetail({ can: { ...itemDetail().can, write: false } }));
    expect(await screen.findByText("Chỉ đọc")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lưu bản nháp" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Gộp vào" })).toBeNull();
  });

  it("tài liệu tách việc đọc lỗi thì báo từng dòng", async () => {
    open(
      fakeClient({
        breakdown: breakdownView({ breakdown: null, errors: [{ line: 14, message: "Thiếu khoá task" }] }),
      }),
    );
    expect(await screen.findByText("Không đọc được tài liệu tách việc (1 lỗi)")).toBeTruthy();
    expect(screen.getByText("Dòng 14: Thiếu khoá task")).toBeTruthy();
  });
});
