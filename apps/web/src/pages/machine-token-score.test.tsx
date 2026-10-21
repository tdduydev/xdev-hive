// @vitest-environment jsdom
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Contract, Machine, MachineTokenScore } from "@xdev-hive/contracts";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenScoreCell, TokenScoreDialog } from "@/pages/machine-token-score.tsx";

vi.mock("@/shell/org-context.ts", () => ({
  useOrg: () => ({ api, org: { id: "org-1" } }),
}));

const MACHINE_ID = "8e8e8e8e-0000-4000-8000-000000000001";
const reportedAt = "2026-10-21T06:00:00.000Z";
const now = new Date("2026-10-21T08:00:00.000Z").getTime();

const machine = (over: Partial<Machine> = {}): Machine =>
  ({
    id: MACHINE_ID,
    teamId: "7e7e7e7e-0000-4000-8000-000000000001",
    name: "dev-ha",
    tokenScore: { score: 81.6, level: "good", coverage: 92, provisional: false, reportedAt },
    ...over,
  }) as Machine;

let detail: MachineTokenScore;
const calls: { path: string; input: unknown }[] = [];

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify({ json: value }), { status, headers: { "content-type": "application/json" } });

const client: ContractRouterClient<Contract> = createORPCClient(
  new RPCLink({
    url: "http://test/rpc",
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname.replace("/rpc/", "");
      const input = (await request.json()).json;
      calls.push({ path, input });
      if (path === "machines/tokenScore") return json(detail);
      return json(null, 404);
    },
  }),
);
const api = createTanstackQueryUtils(client);

function Harness({ value }: { value: Machine }) {
  const [open, setOpen] = useState<Machine | null>(null);
  return (
    <>
      <TokenScoreCell machine={value} now={now} onOpen={() => setOpen(value)} />
      <TokenScoreDialog machine={open} onClose={() => setOpen(null)} />
    </>
  );
}

function mount(value: Machine) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Harness value={value} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
  detail = {
    machineId: MACHINE_ID,
    latest: {
      reportedAt,
      report: {
        scoreVersion: 1,
        generatedAt: reportedAt,
        days: 7,
        machine: { score: 81.6, level: "good", coverage: 92, provisional: false },
        profiles: [
          {
            cli: "claude",
            score: 78,
            coverage: 90,
            share: 0.6,
            groups: { B: { earned: 30, max: 40 }, A: { earned: 48, max: 60 } },
            criteria: [
              { id: "A1", status: "ok", earned: 10, max: 10, value: 12.5, unit: "%" },
              { id: "B2", status: "unknown", earned: 0, max: 8, reason: "not_enough_sessions" },
              { id: "B3", status: "unsupported", earned: 0, max: 5, reason: "some_new_code" },
            ],
          },
        ],
      },
    },
    history: [
      { reportedAt: "2026-09-01T06:00:00.000Z", score: 60, coverage: 80 },
      { reportedAt: "2026-10-01T06:00:00.000Z", score: null, coverage: 30 },
      { reportedAt, score: 81.6, coverage: 92 },
    ],
  };
});

afterEach(cleanup);

describe("điểm token của máy", () => {
  it("máy chưa gửi điểm: gạch ngang kèm lời giải thích, không có nút", () => {
    mount(machine({ tokenScore: null }));
    expect(screen.getByTitle("Máy chưa bật gửi điểm").textContent).toBe("—");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("ô điểm: số nguyên, mức, tạm tính và lúc gửi", () => {
    mount(machine({ tokenScore: { score: 54.4, level: "fair", coverage: 40, provisional: true, reportedAt } }));
    const button = screen.getByRole("button", { name: "Xem điểm token của dev-ha: 54, Khá" });
    expect(button.textContent).toBe("54Khá");
    expect(screen.getByText(/tạm tính · 2 giờ trước/)).toBeTruthy();
  });

  it("bấm điểm mở chi tiết: tóm tắt, nhóm, tiêu chí và bảng xu hướng", async () => {
    mount(machine());
    fireEvent.click(screen.getByRole("button", { name: "Xem điểm token của dev-ha: 82, Tốt" }));
    const dialog = await screen.findByRole("dialog", { name: "Điểm token · dev-ha" });
    await within(dialog).findByRole("table", { name: "Tiêu chí của Claude" });
    expect(calls).toContainEqual({ path: "machines/tokenScore", input: { machineId: MACHINE_ID } });

    // Khối tóm tắt đứng đầu hộp thoại, trước biểu đồ và các gói.
    expect(within(dialog).getAllByText("Phạm vi đo")[0]?.parentElement?.textContent).toBe("Phạm vi đo92%");
    // Nhóm theo thứ tự chữ cái dù hub trả B trước A.
    const groups = within(dialog)
      .getAllByText(/^Nhóm /)
      .map((node) => node.parentElement?.textContent);
    expect(groups).toEqual(["Nhóm A · 48/60", "Nhóm B · 30/40"]);

    const rows = within(within(dialog).getByRole("table", { name: "Tiêu chí của Claude" })).getAllByRole("row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Tiêu chíTrạng tháiĐiểmGiá trị",
      "A1Đạt10/1012,5%",
      "B2Chưa đo0/8—Chưa đủ phiên",
      "B3Không hỗ trợ0/5—some_new_code",
    ]);

    // Đường xu hướng bỏ lần gửi không có điểm; bảng chữ vẫn liệt kê đủ.
    expect(within(dialog).getByRole("img", { name: /qua 2 lần gửi, từ 60 tới 82/ })).toBeTruthy();
    expect(within(dialog).getByText("Xem dạng bảng")).toBeTruthy();
  });

  it("máy có điểm trong danh sách nhưng chưa có bản đầy đủ: báo chưa gửi", async () => {
    detail = { machineId: MACHINE_ID, latest: null, history: [] };
    mount(machine());
    fireEvent.click(screen.getByRole("button", { name: /Xem điểm token/ }));
    expect(await screen.findByText("Máy chưa gửi điểm")).toBeTruthy();
  });
});
