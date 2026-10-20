import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AppliedFix, AppliedFixes, TokenScoreDetail } from "@/components/token-score-detail.tsx";
import { setLang } from "@/lib/i18n.ts";
import { criterion, sampleScore } from "@/lib/token-score.fixture.ts";
import type { FixPreview, TokenScore } from "@/lib/token-score.ts";

type Handler = (args?: Record<string, unknown>) => unknown;

function fakeTauri(handlers: Record<string, Handler>) {
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const handler = handlers[command];
        if (!handler) throw new Error(`lệnh chưa giả: ${command}`);
        return (await handler(args)) as T;
      },
    },
  };
  return calls;
}

const preview = (fixId: FixPreview["fixId"], warnings: string[] = []): FixPreview => ({
  fixId,
  profile: "claude-2",
  changes: [{ file: "~/.claude/settings.json", key: "env.BASH_MAX_OUTPUT_LENGTH", before: "30000", after: "15000" }],
  warnings,
});

/** Giữ danh sách sửa nhanh đã áp dụng như thẻ điểm, để thử luôn nút Hoàn tác. */
function Harness({ score, onChanged }: { score: TokenScore; onChanged: () => void }) {
  const [applied, setApplied] = useState<AppliedFix[]>([]);
  return (
    <>
      <AppliedFixes score={score} applied={applied} setApplied={setApplied} onChanged={onChanged} />
      <TokenScoreDetail score={score} onChanged={onChanged} onApplied={(fix) => setApplied((list) => [...list, fix])} />
    </>
  );
}

beforeEach(() => setLang("vi"));

describe("TokenScoreDetail", () => {
  it("khoá nút sửa nhanh khi điểm đang tải lại", () => {
    render(<TokenScoreDetail score={sampleScore()} onChanged={() => {}} onApplied={() => {}} refreshing />);
    const buttons = screen.getAllByRole("button", { name: /^Bật tối ưu/ });
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it("nút đo /context gọi lại điểm có /context, không mở hộp sửa nhanh", async () => {
    const user = userEvent.setup();
    const score = sampleScore();
    const claude = score.profiles[0];
    if (!claude) throw new Error("fixture thiếu gói");
    claude.criteria = [
      criterion("A4", {
        status: "unknown",
        earned: 0,
        max: 7,
        reason: "context_not_measured",
        fixes: ["context.measure"],
      }),
    ];
    const calls = fakeTauri({});
    const measure = vi.fn();
    render(<TokenScoreDetail score={score} onChanged={() => {}} onApplied={() => {}} onMeasureContext={measure} />);
    await user.click(screen.getByRole("button", { name: "Đo /context (tốn khoảng 50k token)" }));
    expect(measure).toHaveBeenCalledWith("claude-2");
    expect(calls).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("xếp tiêu chí từng gói theo điểm thiếu và hiện lý do của tiêu chí chưa đo hay chưa hỗ trợ", () => {
    const score = sampleScore();
    render(<TokenScoreDetail score={score} onChanged={() => {}} onApplied={() => {}} />);
    const codex = screen.getByRole("region", { name: "Codex codex-1" });
    expect([...codex.querySelectorAll("li[data-criterion]")].map((li) => li.getAttribute("data-criterion"))).toEqual([
      "A1",
      "B4",
      "A6",
    ]);
    expect(within(codex).getByText("CLI này chưa được hỗ trợ.")).toBeTruthy();
    const agy = screen.getByRole("region", { name: "Antigravity agy-1" });
    expect(within(agy).getByText("Không tính vào điểm máy")).toBeTruthy();
  });

  it("tiêu chí chưa đo vẫn có điểm 0 trên điểm tối đa và không có mốc đo", () => {
    const score = sampleScore();
    score.profiles = [
      {
        ...(score.profiles[0] as TokenScore["profiles"][number]),
        criteria: [criterion("B7", { status: "unknown", reason: "not_enough_sessions", earned: 0, max: 6 })],
      },
    ];
    render(<TokenScoreDetail score={score} onChanged={() => {}} onApplied={() => {}} />);
    const row = screen.getByText("Token trước lần sửa đầu").closest("li") as HTMLElement;
    expect(within(row).getByText("0/6 điểm")).toBeTruthy();
    expect(within(row).getByText("Chưa đủ dữ liệu: cần ít nhất 5 phiên chính trong 7 ngày.")).toBeTruthy();
    expect(within(row).queryByText(/Đo được/)).toBeNull();
  });

  it("bấm sửa nhanh: xem trước rồi mới ghi, ghi xong báo để tính lại và nhớ bản sao lưu", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const calls = fakeTauri({
      token_score_fix_preview: () => preview("optimizer.balanced"),
      token_score_fix: () => ({ fixId: "optimizer.balanced", profile: "claude-2", backup: "20261019T010203Z" }),
      token_score_undo: () => ({}),
    });
    render(<Harness score={sampleScore()} onChanged={onChanged} />);
    await user.click(screen.getAllByRole("button", { name: "Bật tối ưu Cân bằng cho Gói Max" })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("30000")).toBeTruthy();
    expect(within(dialog).getByText("15000")).toBeTruthy();
    expect(calls.map((c) => c.command)).toEqual(["token_score_fix_preview"]);
    expect(onChanged).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Áp dụng" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls.map((c) => c.command)).toEqual(["token_score_fix_preview", "token_score_fix"]);
    await user.click(await screen.findByRole("button", { name: "Hoàn tác" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(calls.at(-1)).toEqual({
      command: "token_score_undo",
      args: { fixId: "optimizer.balanced", profileId: "claude-2", projectKey: null, backup: "20261019T010203Z" },
    });
  });

  it("lỗi khi ghi hiện trong hộp, hộp còn mở để thử lại và không tính lại điểm", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    fakeTauri({
      token_score_fix_preview: () => preview("optimizer.balanced"),
      token_score_fix: () => Promise.reject("settings.json đang bị CLI ghi, thử lại sau."),
    });
    render(<Harness score={sampleScore()} onChanged={onChanged} />);
    await user.click(screen.getAllByRole("button", { name: "Bật tối ưu Cân bằng cho Gói Max" })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Áp dụng" }));
    expect(await within(dialog).findByText("settings.json đang bị CLI ghi, thử lại sau.")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Áp dụng" }) as HTMLButtonElement).disabled).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("mức Mạnh: hộp xác nhận nói subagent chạy Sonnet và chất lượng có thể khác", async () => {
    const user = userEvent.setup();
    const calls = fakeTauri({
      token_score_fix_preview: () => preview("optimizer.aggressive", ["quality_may_change"]),
      token_score_fix: () => ({ fixId: "optimizer.aggressive", profile: "claude-2" }),
    });
    render(<Harness score={sampleScore()} onChanged={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Bật mức Mạnh cho Gói Max…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Tiếp tục" }));
    const confirm = await screen.findByRole("dialog", { name: "Bật mức Mạnh?" });
    expect(within(confirm).getByText(/Subagent sẽ chạy Sonnet/)).toBeTruthy();
    expect(calls.map((c) => c.command)).toEqual(["token_score_fix_preview"]);
    await user.click(within(confirm).getByRole("button", { name: "Bật mức Mạnh" }));
    await waitFor(() => expect(calls.map((c) => c.command)).toContain("token_score_fix"));
  });

  it("tiếng Anh", () => {
    setLang("en");
    render(<TokenScoreDetail score={sampleScore()} onChanged={() => {}} onApplied={() => {}} />);
    const claude = screen.getByRole("region", { name: "Claude Code Gói Max" });
    expect(within(claude).getByText("Context ceiling, early compaction")).toBeTruthy();
    expect(within(claude).getByText("Full score ≤ 200k · Zero score ≥ 600k")).toBeTruthy();
    expect(within(claude).getAllByRole("button", { name: "Enable Balanced optimizer for Gói Max" }).length).toBe(2);
  });
});

describe("TokenScoreDetail: A8, B2 và lý do disabled", () => {
  const withCriteria = (criteria: TokenScore["profiles"][number]["criteria"], extra = {}) => {
    const score = sampleScore();
    score.profiles = [{ ...(score.profiles[0] as TokenScore["profiles"][number]), criteria, ...extra }];
    return score;
  };
  const B2 = (): ReturnType<typeof criterion> =>
    criterion("B2", { status: "low", value: 0.6, unit: "ratio", earned: 0, max: 6 });

  it("A8 hiện tỉ trọng token theo họ model, lớn nhất trước, chỉ để xem", () => {
    const score = withCriteria([criterion("A8", { status: "partial", earned: 1, max: 3 })], {
      modelShare: [
        { family: "sonnet", share: 0.25 },
        { family: "opus", share: 0.75 },
      ],
    });
    render(<TokenScoreDetail score={score} onChanged={() => {}} onApplied={() => {}} />);
    const row = screen.getByText("Model và effort mặc định").closest("li") as HTMLElement;
    expect(within(row).getByText("Token 7 ngày theo họ model")).toBeTruthy();
    const items = within(row).getAllByText(/^(Opus|Sonnet)$/);
    expect(items.map((e) => e.textContent)).toEqual(["Opus", "Sonnet"]);
    expect(within(row).getByText("75%")).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("không có modelShare thì A8 không hiện khối tỉ trọng", () => {
    render(
      <TokenScoreDetail
        score={withCriteria([criterion("A8", { status: "partial", earned: 1, max: 3 })])}
        onChanged={() => {}}
        onApplied={() => {}}
      />,
    );
    expect(screen.queryByText("Token 7 ngày theo họ model")).toBeNull();
  });

  it("B2: A1 chưa đủ thì giữ gợi ý tĩnh, A1 đủ thì bỏ vì thẻ đã có gợi ý tách phiên", () => {
    const { unmount } = render(
      <TokenScoreDetail
        score={withCriteria([criterion("A1", { status: "partial", earned: 5, max: 10 }), B2()])}
        onChanged={() => {}}
        onApplied={() => {}}
      />,
    );
    expect(screen.getByText("Sửa A1; /clear giữa các việc không liên quan.")).toBeTruthy();
    unmount();
    render(
      <TokenScoreDetail score={withCriteria([criterion("A1"), B2()])} onChanged={() => {}} onApplied={() => {}} />,
    );
    expect(screen.queryByText("Sửa A1; /clear giữa các việc không liên quan.")).toBeNull();
  });

  it("lý do disabled có chữ riêng, cả hai ngôn ngữ", () => {
    const score = withCriteria([criterion("A5", { status: "unknown", reason: "disabled", earned: 0, max: 3 })]);
    const { unmount } = render(<TokenScoreDetail score={score} onChanged={() => {}} onApplied={() => {}} />);
    expect(screen.getByText("Có nhưng đang tắt.")).toBeTruthy();
    unmount();
    setLang("en");
    render(<TokenScoreDetail score={score} onChanged={() => {}} onApplied={() => {}} />);
    expect(screen.getByText("Present but turned off.")).toBeTruthy();
  });
});
