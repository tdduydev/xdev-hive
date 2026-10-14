import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ConvergePanel } from "./converge-panel.tsx";
import { ItemDetail } from "./item-detail.tsx";
import { convergeRun, fakeClient, itemDetail, modeView, NOW, renderWithEnv, testEnv, uuid } from "./test-fixtures.tsx";

const user = userEvent.setup({ delay: null });
const target = (a: HTMLElement) => JSON.parse(decodeURIComponent(a.getAttribute("href")?.slice(1) ?? "null"));

const ROUND_1 = [
  { requirementId: "FR-001", status: "met", evidence: "refund.ts:40 kiểm số tiền" },
  {
    requirementId: "FR-002",
    status: "missing",
    evidence: "Không thấy giới hạn số lần hoàn",
    suggestedTask: "Thêm giới hạn 3 lần hoàn mỗi giao dịch",
  },
  {
    requirementId: "FR-003",
    status: "contradicts",
    evidence: "Spec nói hoàn trong 30 ngày, code cho 60 ngày",
    suggestedTask: "Sửa hạn hoàn về 30 ngày",
  },
];
const ROUND_2 = [
  { requirementId: "FR-001", status: "met", evidence: "refund.ts:40" },
  { requirementId: "FR-002", status: "partial", evidence: "Có giới hạn nhưng chưa có test" },
];

function open(item = itemDetail(), lang: "vi" | "en" = "vi") {
  const client = fakeClient({ item });
  renderWithEnv(<ConvergePanel item={item} />, testEnv(client, { lang }));
  return client;
}

describe("ConvergePanel", () => {
  it("chưa chạy: mời chạy hội tụ, bấm gọi bước converge-spec", async () => {
    const client = open();
    expect(screen.getAllByText("Chưa chạy hội tụ").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Chạy hội tụ" }));
    expect(client.sdlc.items.step.mock.calls[0]?.[0]).toEqual({
      id: uuid(112),
      phaseId: "converge",
      stepId: "converge-spec",
    });
  });

  it("chưa hội tụ vòng 1/2: mâu thuẫn đứng đầu, có hai hướng sửa, yêu cầu đạt ẩn mặc định", async () => {
    open(itemDetail({ convergeRound: 1, steps: [convergeRun(1, ROUND_1)] }));
    expect(screen.getByText("Chưa hội tụ (vòng 1/2)")).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => within(li).getByText(/^FR-/).textContent)).toEqual(["FR-003", "FR-002"]);
    const contradicts = items[0] as HTMLElement;
    expect(within(contradicts).getByText("Mâu thuẫn")).toBeTruthy();
    expect(within(contradicts).getByText("Sửa hạn hoàn về 30 ngày")).toBeTruthy();
    // Hạng mục chưa có tài liệu tasks thì "sửa code" mở tab Task.
    expect(target(within(contradicts).getByRole("link", { name: "Sửa code: thêm task" }))).toEqual({
      kind: "item",
      projectKey: "payment-api",
      number: 12,
      tab: "tasks",
    });
    expect(target(within(contradicts).getByRole("link", { name: "Sửa tài liệu" }))).toEqual({
      kind: "doc",
      key: "project/payment-api/sdlc/012-hoan-tien-mot-phan/spec",
    });
    expect(within(items[1] as HTMLElement).queryByRole("link", { name: "Sửa tài liệu" })).toBeNull();
    expect(screen.getByText("Đạt 1")).toBeTruthy();

    await user.click(screen.getByLabelText("Ẩn yêu cầu đạt"));
    expect(screen.getByText("refund.ts:40 kiểm số tiền")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chạy vòng tiếp" })).toBeTruthy();
  });

  it("chọn vòng cũ xem lại kết quả vòng đó", async () => {
    open(itemDetail({ convergeRound: 2, steps: [convergeRun(1, ROUND_1), convergeRun(2, ROUND_2)] }));
    expect(screen.getByRole("button", { name: "Vòng 2" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Một phần")).toBeTruthy();
    expect(screen.queryByText("FR-003")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Vòng 1" }));
    expect(screen.getByText("FR-003")).toBeTruthy();
  });

  it("hết vòng mà chưa hội tụ: dừng, báo chủ hạng mục, không cho chạy thêm", () => {
    open(itemDetail({ convergeRound: 2, steps: [convergeRun(1, ROUND_1), convergeRun(2, ROUND_2)] }));
    expect(screen.getByText("Hết 2 vòng mà chưa hội tụ")).toBeTruthy();
    expect(screen.getByText(/Hub đã dừng và báo chủ hạng mục/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Chạy/ })).toBeNull();
  });

  it("đã hội tụ: mọi yêu cầu đạt, không còn nút chạy", () => {
    open(
      itemDetail({
        convergeRound: 1,
        convergedAt: NOW,
        steps: [convergeRun(1, [{ requirementId: "FR-001", status: "met", evidence: "ok" }])],
      }),
    );
    expect(screen.getByText("Đã hội tụ")).toBeTruthy();
    expect(screen.getByText("Mọi yêu cầu đều đạt ở vòng này.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Chạy/ })).toBeNull();
  });

  it("đang chạy và lần chạy lỗi; kết quả sai dạng coi như chưa có", async () => {
    open(
      itemDetail({
        convergeRound: 1,
        steps: [
          convergeRun(1, [], { status: "failed", error: "Agent hết thời gian", result: { findings: "sai" } }),
          convergeRun(2, [], { id: uuid(730), status: "running", result: null, finishedAt: null }),
        ],
      }),
    );
    expect(screen.getByText("Đang chạy")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Chạy/ })).toBeNull();
    expect(screen.getByText("Vòng này chưa có kết quả.")).toBeTruthy();
    // Vòng 1 lỗi: chọn lại để xem lỗi.
    await user.click(screen.getByRole("button", { name: "Vòng 1" }));
    expect(screen.getByText("Lần chạy này lỗi, không có kết quả.")).toBeTruthy();
    expect(screen.getByText("Agent hết thời gian")).toBeTruthy();
  });

  it("người chỉ đọc không thấy nút chạy; tiếng Anh", () => {
    const base = itemDetail();
    open({ ...base, convergeRound: 1, steps: [convergeRun(1, ROUND_1)], can: { ...base.can, write: false } }, "en");
    expect(screen.getByText("Not converged (round 1/2)")).toBeTruthy();
    expect(screen.getByText("Contradicts")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Run/ })).toBeNull();
  });
});

describe("ItemDetail tab Hội tụ", () => {
  it("chế độ có bước converge hiện tab", async () => {
    renderWithEnv(<ItemDetail projectKey="payment-api" number={12} tab="converge" />, testEnv(fakeClient()));
    expect(await screen.findByRole("tab", { name: "Hội tụ", selected: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chạy hội tụ" })).toBeTruthy();
  });

  it("chế độ nhẹ không có bước converge: không có tab, đường dẫn cũ về Tổng quan", async () => {
    const item = itemDetail({ mode: modeView("small").definition });
    renderWithEnv(<ItemDetail projectKey="payment-api" number={12} tab="converge" />, testEnv(fakeClient({ item })));
    expect(await screen.findByRole("tab", { name: "Tổng quan", selected: true })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Hội tụ" })).toBeNull();
  });
});
