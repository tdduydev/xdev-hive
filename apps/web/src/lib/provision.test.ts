import { describe, expect, it } from "vitest";
import { createTaskBlockedReason, provisionInFlight, showsProvision } from "@/lib/provision.ts";

describe("khởi tạo dự án", () => {
  it("hiện các bước khi đang khởi tạo hoặc lỗi", () => {
    expect([showsProvision("provisioning"), showsProvision("failed"), showsProvision("active")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(provisionInFlight([{ state: "done" }, { state: "failed" }])).toBe(false);
    expect(provisionInFlight([{ state: "done" }, { state: "running" }])).toBe(true);
  });

  it("lý do khoá nút Tạo việc", () => {
    expect(createTaskBlockedReason("active", 1, "vi")).toBeNull();
    expect(createTaskBlockedReason("failed", 0, "vi")).toMatch(/khởi tạo dự án bị lỗi/);
    expect(createTaskBlockedReason("provisioning", 0, "en")).toMatch(/being set up/);
    expect(createTaskBlockedReason(undefined, 0, "vi")).toMatch(/chưa có dự án nào đang hoạt động/);
  });
});
