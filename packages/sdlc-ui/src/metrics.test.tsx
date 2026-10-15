import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Metrics } from "./metrics.tsx";
import { fakeClient, metricsView, PAYMENT, renderWithEnv, testEnv } from "./test-fixtures.tsx";

const user = userEvent.setup({ delay: null });
const DAY_MS = 86_400_000;

function open(client = fakeClient(), lang: "vi" | "en" = "vi") {
  renderWithEnv(<Metrics />, testEnv(client, { lang }));
  return client;
}

const lastInput = (client: ReturnType<typeof fakeClient>) => {
  const call = client.sdlc.metrics.mock.calls.at(-1);
  if (!call) throw new Error("metrics chưa được gọi");
  return call[0];
};

afterEach(() => vi.restoreAllMocks());

describe("Metrics", () => {
  it("lead time theo giai đoạn, nút thắt là p50 lớn nhất, thẻ chỉ số", async () => {
    open();
    expect(await screen.findByRole("meter", { name: "Yêu cầu · p50" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Yêu cầu · p50" }).getAttribute("aria-valuetext")).toBe("1,3 ngày");
    expect(screen.getByRole("meter", { name: "Tiếp nhận · p50" }).getAttribute("aria-valuetext")).toBe("2 giờ");
    const bottleneck = screen.getByText("Nút thắt");
    expect(bottleneck.closest("li")?.textContent).toContain("Yêu cầu");
    expect(screen.getByText("12 hạng mục")).toBeTruthy();
    const card = (label: string) => screen.getByText(label).closest("li") as HTMLElement;
    expect(within(card("Thời gian chờ cổng người")).getByText("5,5 giờ")).toBeTruthy();
    expect(within(card("Tỉ lệ trả lại")).getByText("25%")).toBeTruthy();
    expect(within(card("Độ phủ")).getByText("60%")).toBeTruthy();
    expect(within(card("Chi phí agent mỗi hạng mục")).getByText("7,80 USD")).toBeTruthy();
  });

  it("giai đoạn chưa có dữ liệu và chỉ số null hiện gạch ngang", async () => {
    open(fakeClient({ metrics: metricsView({ returnRate: null, coverage: null }) }));
    await screen.findByText("Lead time theo giai đoạn");
    expect(screen.getByRole("meter", { name: "Phát hành · p50" }).getAttribute("aria-valuetext")).toBe("—");
    const card = (label: string) => screen.getByText(label).closest("li") as HTMLElement;
    expect(within(card("Tỉ lệ trả lại")).getByText("—")).toBeTruthy();
    expect(within(card("Độ phủ")).getByText("—")).toBeTruthy();
  });

  it("tự duyệt theo chế độ và theo dự án", async () => {
    open();
    await screen.findByText("Tự duyệt");
    const rows = screen.getAllByRole("row").filter((r) => r.textContent?.includes("Spec Kit"));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Cả chế độ");
    expect(rows[0]?.textContent).toContain("40%");
    expect(rows[1]?.textContent).toContain(PAYMENT.key);
  });

  it("mặc định 30 ngày; đổi khoảng và lọc dự án, chế độ gửi lại truy vấn", async () => {
    const client = open();
    await screen.findByText("Lead time theo giai đoạn");
    const first = lastInput(client);
    expect(Date.parse(first.to) - Date.parse(first.from)).toBe(30 * DAY_MS);
    expect(screen.getByRole("button", { name: "30 ngày" }).getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "7 ngày" }));
    await waitFor(() => {
      const input = lastInput(client);
      expect(Date.parse(input.to) - Date.parse(input.from)).toBe(7 * DAY_MS);
    });
    // Cùng mốc "bây giờ": đổi khoảng không làm trôi đầu `to`.
    expect(lastInput(client).to).toBe(first.to);

    await user.selectOptions(screen.getByLabelText("Dự án"), PAYMENT.id);
    await user.selectOptions(screen.getByLabelText("Chế độ"), "bugfix");
    await waitFor(() => expect(lastInput(client)).toMatchObject({ projectId: PAYMENT.id, modeRef: "bugfix" }));
  });

  it("liên kết sang bảng hạng mục mang theo dự án và chế độ đang lọc", async () => {
    open();
    await screen.findByText("Lead time theo giai đoạn");
    const href = () => screen.getByRole("link", { name: "Mở bảng hạng mục với bộ lọc này" }).getAttribute("href");
    expect(JSON.parse(decodeURIComponent(href()?.slice(1) ?? ""))).toEqual({ kind: "board" });
    expect(screen.getByText(/không lọc theo khoảng thời gian/)).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Dự án"), PAYMENT.id);
    await user.selectOptions(screen.getByLabelText("Chế độ"), "bugfix");
    await waitFor(() =>
      expect(JSON.parse(decodeURIComponent(href()?.slice(1) ?? ""))).toEqual({
        kind: "board",
        projectId: PAYMENT.id,
        modeRef: "bugfix",
      }),
    );
  });

  it("chưa có hạng mục: trạng thái rỗng mời thử 90 ngày", async () => {
    const client = open(fakeClient({ metrics: metricsView({ items: 0 }) }));
    expect(await screen.findByText("Chưa đủ dữ liệu để tính chỉ số.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Chọn 90 ngày" }));
    await waitFor(() => {
      const input = lastInput(client);
      expect(Date.parse(input.to) - Date.parse(input.from)).toBe(90 * DAY_MS);
    });
  });

  it("lỗi hub có nút thử lại", async () => {
    const client = fakeClient();
    client.sdlc.metrics.mockRejectedValueOnce(new Error("Hub không trả lời"));
    open(client);
    expect(await screen.findByText("Không tải được dữ liệu.")).toBeTruthy();
    expect(screen.getByText("Hub không trả lời")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(await screen.findByText("Lead time theo giai đoạn")).toBeTruthy();
  });

  it("tiếng Anh", async () => {
    open(fakeClient(), "en");
    expect(await screen.findByText("Lead time by stage")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Requirements · p50" }).getAttribute("aria-valuetext")).toBe("1.3 d");
    expect(screen.getByText("Bottleneck")).toBeTruthy();
  });
});
