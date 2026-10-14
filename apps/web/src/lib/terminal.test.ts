import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  canSubmitOpen,
  clampSize,
  costOf,
  encodeInput,
  endReasonText,
  expectedPermissions,
  firstSelectable,
  hasTier,
  isEnded,
  isLive,
  isTier,
  machineChoice,
  splitInput,
  tierLabel,
  tierMeaning,
} from "@/lib/terminal.ts";

const machine = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  name: "box",
  online: true,
  fullAccess: false,
  busy: false,
  accounts: [],
  ...over,
});

describe("base64 của khung WebSocket", () => {
  it("đi và về giữ nguyên chữ Việt và emoji", () => {
    const text = "Tiếng Việt có dấu ✓ 🚀";
    expect(new TextDecoder().decode(base64ToBytes(encodeInput(text)))).toBe(text);
  });

  it("mã hoá mảng byte lớn không tràn ngăn xếp", () => {
    const bytes = new Uint8Array(200_000).fill(65);
    expect(base64ToBytes(bytesToBase64(bytes))).toHaveLength(200_000);
  });

  it("cắt đầu vào theo byte UTF-8 và không cắt giữa ký tự", () => {
    const parts = splitInput("ế".repeat(10), 7);
    expect(parts.join("")).toBe("ế".repeat(10));
    for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(7);
    expect(splitInput("")).toEqual([]);
  });
});

describe("cỡ khung", () => {
  it("đưa về khoảng hợp đồng cho phép", () => {
    expect(clampSize(5, 1000)).toEqual({ cols: 20, rows: 200 });
    expect(clampSize(120.4, 32.6)).toEqual({ cols: 120, rows: 33 });
  });
});

describe("trạng thái phiên", () => {
  it("opening và running là còn sống", () => {
    expect(isLive({ state: "opening" })).toBe(true);
    expect(isLive({ state: "running" })).toBe(true);
    expect(isEnded({ state: "closed" })).toBe(true);
    expect(isEnded({ state: "failed" })).toBe(true);
  });

  it("đổi lý do kết thúc của worker thành câu theo ngôn ngữ", () => {
    const base = { state: "closed", endReason: "idle" } as never;
    expect(endReasonText(base, "vi")).toContain("không hoạt động");
    expect(endReasonText(base, "en")).toContain("idle");
    expect(endReasonText({ state: "failed", endReason: null } as never, "vi")).toBe("Phiên bị lỗi.");
    expect(endReasonText({ state: "closed", endReason: "Máy bị tắt." } as never, "vi")).toBe("Máy bị tắt.");
  });
});

describe("chọn máy", () => {
  it("chỉ máy online còn chỗ chọn được; còn lại kèm lý do", () => {
    expect(machineChoice(machine())).toEqual({ selectable: true, reason: null });
    expect(machineChoice(machine({ busy: true }))).toEqual({ selectable: false, reason: "busy" });
    expect(machineChoice(machine({ online: false, busy: true }))).toEqual({ selectable: false, reason: "offline" });
  });

  it("chọn sẵn máy online còn chỗ đầu tiên", () => {
    const list = [machine({ id: "a", busy: true }), machine({ id: "b", online: false }), machine({ id: "c" })];
    expect(firstSelectable(list)?.id).toBe("c");
    expect(firstSelectable([machine({ busy: true })])).toBeUndefined();
  });

  it("quyền dự kiến theo công tắc toàn quyền của máy", () => {
    expect(expectedPermissions({ fullAccess: true })).toBe("full");
    expect(expectedPermissions({ fullAccess: false })).toBe("workspace");
  });
});

describe("mở phiên", () => {
  it("Bypass bắt buộc tick xác nhận; Đề xuất không cần", () => {
    expect(canSubmitOpen({ machineId: "m", mode: "propose", confirmed: false })).toBe(true);
    expect(canSubmitOpen({ machineId: "m", mode: "bypass", confirmed: false })).toBe(false);
    expect(canSubmitOpen({ machineId: "m", mode: "bypass", confirmed: true })).toBe(true);
    expect(canSubmitOpen({ machineId: "", mode: "propose", confirmed: true })).toBe(false);
  });

  it("chi phí: null là chưa đủ dữ liệu, thiếu model cũng vậy", () => {
    const costs = [
      { model: "sonnet", avgRunUsd: 0.4, runs: 20 },
      { model: "opus", avgRunUsd: null, runs: 0 },
    ] as never;
    expect(costOf({ costs }, "sonnet")).toBe(0.4);
    expect(costOf({ costs }, "opus")).toBeNull();
    expect(costOf({ costs: [] }, "opus")).toBeNull();
  });
});

describe("cấp độ", () => {
  it("nhãn và ý nghĩa theo ngôn ngữ", () => {
    expect(tierLabel("light", "vi")).toBe("Nhẹ");
    expect(tierLabel("heavy", "en")).toBe("Heavy");
    expect(tierMeaning("medium", "vi")).toContain("CRUD");
    expect(tierMeaning("heavy", "en")).toContain("security");
  });

  it("chỉ task.create và run.dispatch có cấp độ", () => {
    expect(hasTier({ type: "task.create" })).toBe(true);
    expect(hasTier({ type: "run.dispatch" })).toBe(true);
    expect(hasTier({ type: "run.cancel" })).toBe(false);
    expect(isTier("medium")).toBe(true);
    expect(isTier("")).toBe(false);
  });
});
