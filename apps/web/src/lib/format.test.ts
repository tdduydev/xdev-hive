import { describe, expect, it } from "vitest";
import { formatDay } from "./format.ts";

describe("formatDay", () => {
  it("ngày/tháng/năm", () => expect(formatDay("2026-10-11T12:00:00.000Z")).toBe("11/10/2026"));
  it("chuỗi hỏng thì gạch ngang", () => expect(formatDay("không phải ngày")).toBe("—"));
});
