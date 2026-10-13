import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GateStepper, stepOf } from "./gate-stepper.tsx";
import { aiGate, gate, humanGate, ruleGate } from "./test-fixtures.ts";
import { codeReviewText } from "./text.ts";

describe("stepOf", () => {
  it("checkpoint chưa tới lượt là todo, chỉ checkpoint đang chờ của phiên là current", () => {
    const later = gate({ gateId: "ci", kind: "ext", status: "waiting", startedAt: null });
    expect(stepOf(humanGate, "po")).toBe("current");
    expect(stepOf(later, "po")).toBe("todo");
    expect(stepOf(gate({ gateId: "x", kind: "rule", status: "failed" }), "po")).toBe("failed");
    expect(stepOf(gate({ gateId: "y", kind: "rule", status: "skipped" }), "po")).toBe("skipped");
  });
});

describe("GateStepper", () => {
  it("đánh dấu bước hiện tại và đọc được cho trình đọc màn hình", () => {
    render(<GateStepper gates={[ruleGate, aiGate, humanGate]} currentGateId="po" t={codeReviewText.vi} />);
    expect(screen.getByRole("list", { name: "Các bước của quy trình" })).toBeTruthy();
    const current = screen.getByText("PO duyệt").closest("[aria-current]");
    expect(current?.getAttribute("aria-current")).toBe("step");
    expect(screen.getAllByText("(đã qua)")).toHaveLength(2);
    expect(screen.getByText("(đang chờ)")).toBeTruthy();
  });
});
