import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OptimizerPanel } from "@/components/optimizer-panel.tsx";
import { setLang } from "@/lib/i18n.ts";
import type { OptimizerReport, OptimizerStatus, SourceStats } from "@/lib/optimizer.ts";

const stats: SourceStats = {
  sessions: 5,
  calls: 20,
  weighted: 20000,
  medianPeakContext: 180000,
  peakOver150k: 3,
  peakOver400k: 1,
  cacheHit: 0.95,
};
const status: OptimizerStatus = {
  profiles: [
    {
      id: "claude-2",
      cli: "claude",
      configDir: "/fake/claude-2",
      version: "2.1.299",
      supported: true,
      enabled: false,
      inAccounts: true,
      backups: ["20261014T000000Z"],
    },
    {
      id: "codex-2",
      cli: "codex",
      configDir: "/fake/codex-2",
      supported: true,
      enabled: true,
      level: "balanced",
      inAccounts: true,
    },
    {
      id: "gemini-2",
      cli: "gemini",
      configDir: "/fake/gemini-2",
      supported: false,
      reason: "Chưa hỗ trợ tối ưu cho CLI này",
      enabled: false,
      inAccounts: true,
    },
  ],
};
const report: OptimizerReport = {
  days: 7,
  sessions: 7,
  bySource: { "claude/interactive": stats },
  split: {
    cutoff: "2026-10-14T00:00:00Z",
    sessionsBefore: 2,
    sessionsAfter: 5,
    before: {
      bySource: {
        "claude/interactive": {
          ...stats,
          sessions: 2,
          calls: 10,
          weighted: 20000,
          medianPeakContext: 450000,
          cacheHit: 0.8,
        },
      },
    },
    after: { bySource: { "claude/interactive": stats } },
  },
  trimmed: { entries: 1, charsBefore: 30000, charsAfter: 12000, charsCut: 18000 },
  rtkGain: { total_saved: 123 },
};

function fake(handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {}) {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (handlers[command]) return await handlers[command](args);
    if (command === "optimizer_status") return status;
    if (command === "optimizer_report") return report;
    throw new Error(`Lệnh chưa giả: ${command}`);
  });
  window.__TAURI__ = { core: { invoke: invoke as NonNullable<Window["__TAURI__"]>["core"]["invoke"] } };
  return invoke;
}

const profileRow = (id: string) =>
  within(
    screen
      .getByText(`${id.startsWith("codex") ? "codex" : id.startsWith("gemini") ? "gemini" : "claude"} · ${id}`)
      .closest("tr") as HTMLElement,
  );

describe("OptimizerPanel", () => {
  beforeEach(() => setLang("vi"));

  it("chạy offline, hiện các gói, cảnh báo thiếu mẫu và số liệu trước/sau đúng nguồn", async () => {
    const invoke = fake();
    render(<OptimizerPanel />);
    await screen.findByRole("table", { name: "Trước và sau tối ưu" });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["optimizer_status", "optimizer_report"]);
    expect(invoke).toHaveBeenCalledWith("optimizer_report", { profile: "claude-2", days: 7 });
    expect(screen.getByText("2.1.299")).toBeTruthy();
    expect(screen.getByText("Chưa hỗ trợ tối ưu cho CLI này")).toBeTruthy();
    expect((profileRow("gemini-2").getByRole("button", { name: "Bật" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("Thư mục mặc định")).toHaveLength(2);
    expect(screen.getByText("Chưa đủ dữ liệu (< 5 phiên)")).toBeTruthy();
    const rows = within(screen.getByRole("table", { name: "Trước và sau tối ưu" }))
      .getAllByRole("row")
      .slice(1);
    expect(rows[0]?.textContent).toContain("2k10k450k3180%");
    expect(rows[1]?.textContent).toContain("1k4k180k3195%");
    expect(screen.getByText("18.000")).toBeTruthy();
    expect(screen.getByText("123")).toBeTruthy();
  });

  it("bật mức đã chọn, giữ cảnh báo user_set và đọc lại báo cáo; tắt đúng gói", async () => {
    const user = userEvent.setup();
    const enabled: OptimizerStatus = {
      profiles: [
        {
          ...status.profiles[0]!,
          enabled: true,
          level: "aggressive",
          updatedAt: "2026-10-14T01:00:00Z",
          skipped: [{ key: "hooks.PostToolUse", reason: "CLI chưa hỗ trợ" }],
        },
        ...status.profiles.slice(1),
      ],
      result: {
        profile: "claude-2",
        changed: true,
        warnings: [{ key: "env.BASH_MAX_OUTPUT_LENGTH", kind: "user_set", message: "Giữ giá trị của người dùng" }],
      },
    };
    const invoke = fake({ optimizer_enable: () => enabled, optimizer_disable: () => status });
    render(<OptimizerPanel />);
    await screen.findByText("2.1.299");
    await user.selectOptions(screen.getByLabelText("Mức claude-2"), "aggressive");
    await user.click(profileRow("claude-2").getByRole("checkbox"));
    await user.click(profileRow("claude-2").getByRole("button", { name: "Bật" }));
    expect(invoke).toHaveBeenCalledWith("optimizer_enable", { profile: "claude-2", level: "aggressive", rtk: true });
    expect(await screen.findByText("env.BASH_MAX_OUTPUT_LENGTH: Giữ giá trị của người dùng")).toBeTruthy();
    expect(screen.getByText("hooks.PostToolUse: CLI chưa hỗ trợ")).toBeTruthy();
    await user.click(profileRow("claude-2").getByRole("button", { name: "Tắt" }));
    expect(invoke).toHaveBeenCalledWith("optimizer_disable", { profile: "claude-2" });
    await waitFor(() => expect(invoke.mock.calls.filter(([c]) => c === "optimizer_report")).toHaveLength(3));
  });

  it("chỉ khôi phục sau xác nhận, gửi bản sao lưu cụ thể", async () => {
    const user = userEvent.setup();
    const invoke = fake({ optimizer_restore: () => status });
    render(<OptimizerPanel />);
    await screen.findByText("2.1.299");
    await user.selectOptions(screen.getByLabelText("Bản sao lưu claude-2"), "20261014T000000Z");
    await user.click(profileRow("claude-2").getByRole("button", { name: "Khôi phục" }));
    expect(invoke.mock.calls.some(([c]) => c === "optimizer_restore")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Huỷ" }));
    expect(screen.queryByRole("button", { name: "Xác nhận khôi phục" })).toBeNull();
    await user.click(profileRow("claude-2").getByRole("button", { name: "Khôi phục" }));
    await user.click(screen.getByRole("button", { name: "Xác nhận khôi phục" }));
    expect(invoke).toHaveBeenCalledWith("optimizer_restore", { profile: "claude-2", backup: "20261014T000000Z" });
  });

  it("chỉ bật thư mục mặc định khi chọn Bật của riêng gói đó", async () => {
    const user = userEvent.setup();
    const invoke = fake({ optimizer_enable: () => status });
    render(<OptimizerPanel />);
    await screen.findByText("2.1.299");
    expect(invoke.mock.calls.some(([c]) => c === "optimizer_enable")).toBe(false);
    await user.click(profileRow("claude").getByRole("button", { name: "Bật" }));
    expect(invoke).toHaveBeenCalledWith("optimizer_enable", { profile: "claude", level: "balanced", rtk: false });
  });

  it("lỗi bật không đổi trạng thái; lỗi báo cáo vẫn cho thao tác và thử lại", async () => {
    const user = userEvent.setup();
    const invoke = fake({
      optimizer_enable: () => Promise.reject("File cấu hình hỏng, không ghi gì."),
      optimizer_report: () => Promise.reject("Không đọc được báo cáo."),
    });
    render(<OptimizerPanel />);
    await screen.findByText("Không đọc được báo cáo.");
    await user.click(profileRow("claude-2").getByRole("button", { name: "Bật" }));
    expect(await screen.findByText("File cấu hình hỏng, không ghi gì.")).toBeTruthy();
    expect(profileRow("claude-2").getByText("Đang tắt")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Đọc lại tối ưu" }));
    await waitFor(() => expect(invoke.mock.calls.filter(([c]) => c === "optimizer_status")).toHaveLength(2));
  });

  it("không nhận báo cáo cũ khi đổi gói; chưa bật thì hiện số liệu hiện tại", async () => {
    const user = userEvent.setup();
    let oldResolve: ((report: OptimizerReport) => void) | undefined;
    fake({
      optimizer_report: (args) =>
        args?.profile === "claude-2"
          ? new Promise<OptimizerReport>((resolve) => {
              oldResolve = resolve;
            })
          : { days: 7, sessions: 5, bySource: { "codex/worker": stats } },
    });
    render(<OptimizerPanel />);
    await screen.findByText("2.1.299");
    await user.selectOptions(screen.getByLabelText("Gói báo cáo"), "codex-2");
    expect(await screen.findByText("codex · Worker")).toBeTruthy();
    oldResolve?.(report);
    await waitFor(() => expect(screen.queryByText("claude · Tương tác")).toBeNull());
    expect(screen.getByText("Chưa có mốc bật tối ưu. Đang hiển thị số liệu hiện tại.")).toBeTruthy();
    expect(screen.getByText("Chưa có số liệu RTK.")).toBeTruthy();
  });

  it("chép báo cáo chỉ số và báo lỗi clipboard bằng tiếng Việt", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    fake();
    render(<OptimizerPanel />);
    await screen.findByRole("table", { name: "Trước và sau tối ưu" });
    await user.click(screen.getByRole("button", { name: "Chép báo cáo" }));
    expect(await screen.findByText("Đã chép báo cáo chỉ gồm số liệu.")).toBeTruthy();
    expect(JSON.parse(writeText.mock.calls[0]![0]).bySource["claude/interactive"].perCall).toBe(1000);
    writeText.mockRejectedValueOnce(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Chép báo cáo" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Không chép được báo cáo vào clipboard.");
    writeText.mockRestore();
  });

  it("hiện trạng thái rỗng và từ điển tiếng Anh", async () => {
    setLang("en");
    fake({
      optimizer_status: () => ({ profiles: [] }),
      optimizer_report: () => ({ days: 7, sessions: 0, bySource: {} }),
    });
    render(<OptimizerPanel />);
    expect(await screen.findByText("No sessions in this report's range.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Token optimizer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy report" })).toBeTruthy();
  });
});
