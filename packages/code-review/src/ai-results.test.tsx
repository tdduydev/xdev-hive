import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AiResults } from "./ai-results.tsx";
import { aiGate, gate, humanGate } from "./test-fixtures.ts";
import { codeReviewText } from "./text.ts";

describe("AiResults", () => {
  it("hiện điểm, tóm tắt, rubric và phát hiện theo mức", () => {
    render(<AiResults gates={[aiGate, humanGate]} t={codeReviewText.vi} />);
    expect(screen.getByText("8,0 / 10", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("Logic hoàn tiền đúng, thiếu test biên.")).toBeTruthy();
    expect(screen.getByText("Thiếu ca hoàn hai lần")).toBeTruthy();
    expect(screen.getByText("src/refund.ts:11")).toBeTruthy();
    expect(screen.getByText("Lớn")).toBeTruthy();
  });

  it("reviewer chờ máy: nói rõ lý do, không hiện điểm", () => {
    const waiting = gate({
      gateId: "ai",
      kind: "ai",
      status: "waiting",
      reviewers: [
        {
          cli: "codex",
          model: null,
          runId: null,
          state: "waiting_machine",
          score: null,
          passed: null,
          summary: null,
          findings: [],
          checklist: [],
          error: null,
        },
      ],
    });
    render(<AiResults gates={[waiting]} t={codeReviewText.vi} />);
    expect(screen.getByText("Chờ máy có CLI này")).toBeTruthy();
    expect(screen.queryByText(/\/ 10/)).toBeNull();
  });

  it("không có checkpoint AI thì không vẽ gì", () => {
    const { container } = render(<AiResults gates={[humanGate]} t={codeReviewText.en} />);
    expect(container.firstChild).toBeNull();
  });
});
