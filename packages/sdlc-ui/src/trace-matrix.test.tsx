import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClient, itemDetail, renderWithEnv, testEnv, traceView, WEB } from "./test-fixtures.tsx";
import { TraceMatrix } from "./trace-matrix.tsx";

const user = userEvent.setup({ delay: null });

function open(client = fakeClient()) {
  renderWithEnv(<TraceMatrix item={itemDetail()} />, testEnv(client));
  return client;
}

afterEach(() => vi.restoreAllMocks());

describe("TraceMatrix", () => {
  it("độ phủ tổng và theo dự án, requirement chưa có task", async () => {
    open();
    expect(await screen.findByRole("meter", { name: "Độ phủ tổng · Có task" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "web-shop · Có test" }).getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getAllByText("Chưa có task").length).toBeGreaterThan(0);
    expect(screen.getAllByText("T-41 (payment-api)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("abcdef1").length).toBeGreaterThan(0);
  });

  it("lọc theo dự án gửi projectId, chỉ yêu cầu chưa đủ ẩn hàng đã xong", async () => {
    const client = open();
    await screen.findByText("Ma trận yêu cầu");
    await user.click(screen.getByLabelText("Chỉ yêu cầu chưa đủ"));
    expect(screen.queryAllByText("Hoàn tiền một phần")).toHaveLength(0);
    expect(screen.getAllByText("Gửi email").length).toBeGreaterThan(0);
    await user.selectOptions(screen.getByLabelText("Dự án"), WEB.id);
    await waitFor(() =>
      expect(client.sdlc.trace).toHaveBeenCalledWith({ id: itemDetail().id, projectId: WEB.id }, expect.anything()),
    );
  });

  it("xuất CSV tải file theo hạng mục", async () => {
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const client = open(fakeClient({ trace: traceView() }));
    await user.click(await screen.findByRole("button", { name: "Xuất CSV" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(client.sdlc.trace).toHaveBeenCalledWith({ id: itemDetail().id, format: "csv" }, expect.anything());
    expect(create).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });

  it("chưa có requirement thì báo trống", async () => {
    open(fakeClient({ trace: traceView({ rows: [] }) }));
    expect(await screen.findByText("Chưa có gì để truy vết")).toBeTruthy();
  });
});
