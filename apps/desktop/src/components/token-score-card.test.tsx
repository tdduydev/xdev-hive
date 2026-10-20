import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenScoreCard } from "@/components/token-score-card.tsx";
import { setLang } from "@/lib/i18n.ts";
import { sampleScore } from "@/lib/token-score.fixture.ts";
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

const commands = (calls: { command: string }[]) => calls.map((c) => c.command);

const balancedPreview: FixPreview = {
  fixId: "optimizer.balanced",
  profile: "claude-2",
  changes: [
    {
      file: "~/.claude/settings.json",
      key: "env.CLAUDE_CODE_AUTO_COMPACT_WINDOW",
      before: null,
      after: "200000",
    },
  ],
  warnings: [],
};

const better = (): TokenScore => {
  const score = sampleScore();
  return { ...score, machine: { ...score.machine, score: 61.2, level: "fair" }, previous: { score: 55, at: "x" } };
};

beforeEach(() => setLang("vi"));

describe("TokenScoreCard: thẻ điểm", () => {
  it("hiện điểm, mức, phạm vi đo, chênh lệch, hai nhóm và điểm từng gói", async () => {
    const calls = fakeTauri({ token_score: () => sampleScore() });
    render(<TokenScoreCard />);
    expect(await screen.findByText("55,0")).toBeTruthy();
    expect(calls[0]).toEqual({ command: "token_score", args: { fresh: false, profileId: null } });
    expect(screen.getByText("Cần cải thiện")).toBeTruthy();
    expect(screen.getByText("Đo được 87/100 điểm")).toBeTruthy();
    expect(screen.getByText("Tăng 3,5 điểm so với lần tính trước")).toBeTruthy();
    expect(screen.queryByText("tạm tính")).toBeNull();
    expect(screen.getByRole("progressbar", { name: "Nhóm A · Cấu hình" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Nhóm B · Số liệu phiên" })).toBeTruthy();
    expect(screen.getByText("Gói Max")).toBeTruthy();
    expect(screen.getByText("80% token 7 ngày")).toBeTruthy();
    expect(screen.getByText("20% token 7 ngày")).toBeTruthy();
    // Antigravity không có log token: có điểm cấu hình nhưng không tính vào điểm máy, kèm lý do.
    expect(screen.getByText("không tính vào điểm máy · không có log token")).toBeTruthy();
    expect(screen.getByText(/không đo chất lượng kết quả/)).toBeTruthy();
  });

  it("gắn nhãn tạm tính khi mới đo được dưới 50 điểm", async () => {
    const score = sampleScore();
    fakeTauri({ token_score: () => ({ ...score, machine: { ...score.machine, coverage: 38, provisional: true } }) });
    render(<TokenScoreCard />);
    expect(await screen.findByText("tạm tính")).toBeTruthy();
    expect(screen.getByText("Đo được 38/100 điểm")).toBeTruthy();
  });

  it("chưa có điểm máy thì không hiện mức và nói lý do", async () => {
    const score = sampleScore();
    fakeTauri({
      token_score: () => ({
        ...score,
        machine: { score: null, level: null, coverage: 0, provisional: true },
        profiles: score.profiles.slice(2),
      }),
    });
    render(<TokenScoreCard />);
    expect(await screen.findByText(/Chưa có điểm máy/)).toBeTruthy();
    expect(screen.queryByText("Cần cải thiện")).toBeNull();
    expect(screen.getByText("—", { selector: "span.text-4xl" })).toBeTruthy();
  });

  it("Tính lại gọi bỏ qua cache; lỗi hiện bằng chữ và giữ điểm đang xem", async () => {
    const user = userEvent.setup();
    let fail = false;
    const calls = fakeTauri({
      token_score: () => {
        if (fail) throw "Không chạy được worker.";
        return sampleScore();
      },
    });
    render(<TokenScoreCard />);
    await screen.findByText("55,0");
    fail = true;
    await user.click(screen.getByRole("button", { name: "Tính lại" }));
    expect(await screen.findByText("Không chạy được worker.")).toBeTruthy();
    expect(calls.at(-1)).toEqual({ command: "token_score", args: { fresh: false, profileId: null } });
    expect(screen.getByText("55,0")).toBeTruthy();
  });

  it("chép báo cáo chỉ có số, không có id gói, nhãn và đường dẫn", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    fakeTauri({ token_score: () => sampleScore() });
    render(<TokenScoreCard />);
    await screen.findByText("55,0");
    await user.click(screen.getByRole("button", { name: "Chép báo cáo điểm" }));
    expect(await screen.findByText("Đã chép báo cáo chỉ gồm số liệu.")).toBeTruthy();
    const copied = String(writeText.mock.calls[0]?.[0]);
    for (const secret of ["claude-2", "codex-1", "agy-1", "Gói Max", "~/work", "p1", "MCP tools"]) {
      expect(copied).not.toContain(secret);
    }
    expect(JSON.parse(copied).machine.score).toBe(55);
    writeText.mockRejectedValueOnce(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Chép báo cáo điểm" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Không chép được báo cáo vào clipboard.");
    writeText.mockRestore();
  });

  it("gợi ý không có tiêu chí nào để đặt thì hiện ở thẻ", async () => {
    fakeTauri({ token_score: () => sampleScore() });
    render(
      <TokenScoreCard
        tips={[{ title: "Bớt subagent cho việc nhỏ", why: "Phiên dùng nhiều subagent." }]}
        hints={[{ cli: "gemini", criterion: "B1", title: "Gợi ý lạc", why: "Không có gói Gemini." }]}
      />,
    );
    expect(await screen.findByText("Bớt subagent cho việc nhỏ")).toBeTruthy();
    expect(screen.getByText("Gợi ý lạc")).toBeTruthy();
  });

  it("tiếng Anh", async () => {
    setLang("en");
    fakeTauri({ token_score: () => sampleScore() });
    render(<TokenScoreCard />);
    expect(await screen.findByText("Needs work")).toBeTruthy();
    expect(screen.getByText("Measured 87/100 points")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy score report" })).toBeTruthy();
    expect(screen.getByText("not counted in the machine score · no token logs")).toBeTruthy();
  });
});

describe("TokenScoreCard: chi tiết", () => {
  async function open(handlers: Record<string, Handler> = {}, extra?: Parameters<typeof TokenScoreCard>[0]) {
    const user = userEvent.setup();
    const calls = fakeTauri({ token_score: () => sampleScore(), ...handlers });
    render(<TokenScoreCard {...extra} />);
    await screen.findByText("55,0");
    await user.click(screen.getByRole("button", { name: "Xem chi tiết" }));
    return { user, calls };
  }

  const claudeSection = () => screen.getByRole("region", { name: "Claude Code Gói Max" });

  it("tiêu chí xếp theo điểm thiếu, chưa đo ở cuối, kèm mốc, nguồn, mục con và gợi ý", async () => {
    await open();
    const ids = [...claudeSection().querySelectorAll("li[data-criterion]")].map((li) =>
      li.getAttribute("data-criterion"),
    );
    expect(ids).toEqual(["B1", "A1", "A4", "B2", "A2", "B5", "A8", "A5", "A3", "A7", "B3", "B4", "B6", "A6", "B7"]);
    const a1 = within(claudeSection()).getByText("Trần ngữ cảnh, nén sớm").closest("li") as HTMLElement;
    expect(within(a1).getByText("967k")).toBeTruthy();
    expect(within(a1).getByText("Đủ điểm ≤ 200k · 0 điểm ≥ 600k")).toBeTruthy();
    expect(within(a1).getByText("0/10 điểm")).toBeTruthy();
    expect(within(a1).getByText("Nguồn: /context của gói")).toBeTruthy();
    expect(within(a1).getByText("Dùng /compact giữa các việc, /clear khi đổi việc.")).toBeTruthy();
    const b2 = within(claudeSection()).getByText("Token ở phiên rất dài").closest("li") as HTMLElement;
    expect(within(b2).getByText("30%")).toBeTruthy();
    expect(within(b2).getByText("Đủ điểm ≤ 10% · 0 điểm ≥ 50%")).toBeTruthy();
    const a2 = within(claudeSection()).getByText("Trần output tool").closest("li") as HTMLElement;
    expect(within(a2).getByText("Hook cắt output của Hive")).toBeTruthy();
    expect(within(a2).getByText("Có giá trị do người dùng đặt; sửa nhanh không ghi đè.")).toBeTruthy();
    // Tiêu chí đủ điểm không có gợi ý và nút sửa.
    const a3 = within(claudeSection()).getByText("File chỉ dẫn gọn").closest("li") as HTMLElement;
    expect(within(a3).queryByRole("button")).toBeNull();
    expect(within(a3).queryByText(/Chuyển hướng dẫn/)).toBeNull();
    // Chưa đo: có lý do, không có điểm đo.
    expect(screen.getByText("RTK chưa dùng được trên Windows.")).toBeTruthy();
    expect(screen.getByText("Chưa có phiên nào sửa file trong 7 ngày.")).toBeTruthy();
  });

  it("gợi ý cũ của màn Token nằm dưới đúng tiêu chí của gói cùng CLI", async () => {
    await open(
      {},
      {
        hints: [
          { cli: "claude", criterion: "B1", title: "Gọn ngữ cảnh sớm hơn", why: "Dùng /compact giữa các việc." },
          { cli: "codex", criterion: "A1", title: "Dùng /compact trong Codex", why: "Lượt gần nhất quá 70%." },
        ],
      },
    );
    const b1 = within(claudeSection()).getByText("Ngữ cảnh đỉnh").closest("li") as HTMLElement;
    expect(within(b1).getByText("Gọn ngữ cảnh sớm hơn.")).toBeTruthy();
    const codex = screen.getByRole("region", { name: "Codex codex-1" });
    expect(within(codex).getByText("Dùng /compact trong Codex.")).toBeTruthy();
    expect(within(claudeSection()).queryByText("Dùng /compact trong Codex.")).toBeNull();
  });

  it("nút mở màn khác và danh sách nhóm /context", async () => {
    const { user } = await open();
    // RTK chưa dùng được trên Windows: không có nút cài.
    expect(screen.queryByRole("button", { name: "Cài rtk ở màn Môi trường" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cài codegraph ở màn Môi trường" }));
    expect(location.hash).toBe("#/setup");
    await user.click(screen.getByRole("button", { name: "Mở trong màn Memory" }));
    expect(location.hash).toBe("#/memory");
    const toggle = screen.getByRole("button", { name: "Xem MCP và skill đang nạp" });
    await user.click(toggle);
    const list = (await screen.findByText("MCP tools")).closest("ul") as HTMLElement;
    // Nhóm tốn nhiều token nhất lên đầu.
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["MCP tools10,7k", "Skills4,3k"]);
    await user.click(screen.getByRole("button", { name: "Ẩn danh sách" }));
    expect(screen.queryByText("MCP tools")).toBeNull();
  });
});

describe("TokenScoreCard: sửa nhanh", () => {
  async function open(handlers: Record<string, Handler>) {
    const user = userEvent.setup();
    const calls = fakeTauri({ token_score: () => sampleScore(), ...handlers });
    render(<TokenScoreCard />);
    await screen.findByText("55,0");
    await user.click(screen.getByRole("button", { name: "Xem chi tiết" }));
    return { user, calls };
  }

  it("xem trước, áp dụng, tính lại điểm rồi hoàn tác bằng bản sao lưu của lần áp dụng", async () => {
    let scored = 0;
    const { user, calls } = await open({
      token_score: () => (scored++ === 0 ? sampleScore() : better()),
      token_score_fix_preview: () => balancedPreview,
      token_score_fix: () => ({ fixId: "optimizer.balanced", profile: "claude-2", backup: "20261019T000000Z" }),
      token_score_undo: () => ({}),
    });
    const [fixButton] = screen.getAllByRole("button", { name: "Bật tối ưu Cân bằng cho Gói Max" });
    await user.click(fixButton as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("env.CLAUDE_CODE_AUTO_COMPACT_WINDOW")).toBeTruthy();
    expect(within(dialog).getByText("~/.claude/settings.json")).toBeTruthy();
    expect(within(dialog).getByText("(chưa có)")).toBeTruthy();
    expect(within(dialog).getByText("200000")).toBeTruthy();
    // Chỉ xem trước: chưa ghi gì.
    expect(commands(calls)).toEqual(["token_score", "token_score_fix_preview"]);
    expect(calls[1]?.args).toEqual({ fixId: "optimizer.balanced", profileId: "claude-2", projectKey: null });

    await user.click(within(dialog).getByRole("button", { name: "Áp dụng" }));
    expect(await screen.findByText("Đã áp dụng: Bật tối ưu mức Cân bằng (Gói Max).")).toBeTruthy();
    expect(await screen.findByText("61,2")).toBeTruthy();
    expect(commands(calls)).toEqual(["token_score", "token_score_fix_preview", "token_score_fix", "token_score"]);
    expect(calls[2]?.args).toEqual({ fixId: "optimizer.balanced", profileId: "claude-2", projectKey: null });
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Hoàn tác" }));
    await waitFor(() => expect(screen.queryByText(/Đã áp dụng:/)).toBeNull());
    expect(calls.find((c) => c.command === "token_score_undo")?.args).toEqual({
      fixId: "optimizer.balanced",
      profileId: "claude-2",
      projectKey: null,
      backup: "20261019T000000Z",
    });
    expect(commands(calls).at(-1)).toBe("token_score");
  });

  it("lỗi xem trước hiện bằng chữ và không ghi gì", async () => {
    const { user, calls } = await open({
      token_score_fix_preview: () => Promise.reject("Gói này không có trong kết quả điểm gần nhất."),
    });
    const [fixButton] = screen.getAllByRole("button", { name: "Bật tối ưu Cân bằng cho Gói Max" });
    await user.click(fixButton as HTMLElement);
    expect(await screen.findByText("Gói này không có trong kết quả điểm gần nhất.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(commands(calls)).not.toContain("token_score_fix");
  });

  it("huỷ hộp xem trước thì không áp dụng", async () => {
    const { user, calls } = await open({ token_score_fix_preview: () => balancedPreview });
    const [fixButton] = screen.getAllByRole("button", { name: "Bật tối ưu Cân bằng cho Gói Max" });
    await user.click(fixButton as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Huỷ" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(commands(calls)).not.toContain("token_score_fix");
  });

  it("mức Mạnh cần hộp xác nhận riêng, nút xác nhận không phải nút mặc định", async () => {
    const aggressive: FixPreview = {
      fixId: "optimizer.aggressive",
      profile: "claude-2",
      changes: [
        { file: "~/.claude/settings.json", key: "env.CLAUDE_CODE_SUBAGENT_MODEL", before: null, after: "sonnet" },
      ],
      warnings: ["quality_may_change"],
    };
    const { user, calls } = await open({
      token_score_fix_preview: () => aggressive,
      token_score_fix: () => ({ fixId: "optimizer.aggressive", profile: "claude-2", backup: "b1" }),
    });
    await user.click(screen.getByRole("button", { name: "Bật mức Mạnh cho Gói Max…" }));
    const preview = await screen.findByRole("dialog");
    expect(within(preview).getByText("env.CLAUDE_CODE_SUBAGENT_MODEL")).toBeTruthy();
    expect(within(preview).getByText("Chất lượng kết quả có thể khác.")).toBeTruthy();
    // Hộp xem trước của mức Mạnh không có nút áp dụng; phải qua hộp xác nhận.
    expect(within(preview).queryByRole("button", { name: "Áp dụng" })).toBeNull();
    await user.click(within(preview).getByRole("button", { name: "Tiếp tục" }));

    const confirm = await screen.findByRole("dialog", { name: "Bật mức Mạnh?" });
    expect(within(confirm).getByText(/Subagent sẽ chạy Sonnet/)).toBeTruthy();
    expect(within(confirm).getAllByText(/Chất lượng kết quả có thể khác/).length).toBeGreaterThan(0);
    expect(commands(calls)).not.toContain("token_score_fix");
    // "Giữ nguyên" là nút được focus; nút bật mức Mạnh chỉ là nút viền.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Giữ nguyên" })),
    );

    await user.click(within(confirm).getByRole("button", { name: "Giữ nguyên" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(commands(calls)).not.toContain("token_score_fix");

    await user.click(screen.getByRole("button", { name: "Bật mức Mạnh cho Gói Max…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Tiếp tục" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Bật mức Mạnh?" })).getByRole("button", {
        name: "Bật mức Mạnh",
      }),
    );
    expect(await screen.findByText("Đã áp dụng: Bật tối ưu mức Mạnh (Gói Max).")).toBeTruthy();
    expect(calls.find((c) => c.command === "token_score_fix")?.args).toEqual({
      fixId: "optimizer.aggressive",
      profileId: "claude-2",
      projectKey: null,
    });
  });

  it("codegraph init gửi khoá dự án chưa có chỉ mục, hoàn tác tra lại khoá theo đường dẫn", async () => {
    let scored = 0;
    const renumbered = (): TokenScore => {
      // Lần tính sau đánh khoá lại: dự án cũ giờ mang khoá khác.
      const score = sampleScore();
      const claude = score.profiles[0];
      if (claude) {
        claude.projects = [
          { key: "q7", path: "~/work/app", share: 0.62, codegraph: false },
          { key: "q8", path: "~/work/lib", share: 0.38, codegraph: true },
        ];
      }
      return score;
    };
    const { user, calls } = await open({
      token_score: () => (scored++ === 0 ? sampleScore() : renumbered()),
      token_score_fix_preview: () => ({
        fixId: "codegraph.init",
        profile: "claude-2",
        changes: [{ file: "~/work/app", key: "codegraph init -y ~/work/app", before: null, after: "indexed" }],
        warnings: ["long_running"],
      }),
      token_score_fix: () => ({ fixId: "codegraph.init", profile: "claude-2" }),
      token_score_undo: () => ({}),
    });
    await user.click(screen.getByRole("button", { name: "Lập chỉ mục codegraph: ~/work/app" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("đã lập chỉ mục")).toBeTruthy();
    expect(within(dialog).getByText(/vài phút/)).toBeTruthy();
    expect(calls.find((c) => c.command === "token_score_fix_preview")?.args?.projectKey).toBe("p1");
    await user.click(within(dialog).getByRole("button", { name: "Áp dụng" }));
    await screen.findByText(/Đã áp dụng: Lập chỉ mục codegraph cho dự án/);
    await user.click(screen.getByRole("button", { name: "Hoàn tác" }));
    await waitFor(() => expect(commands(calls)).toContain("token_score_undo"));
    expect(calls.find((c) => c.command === "token_score_undo")?.args).toEqual({
      fixId: "codegraph.init",
      profileId: "claude-2",
      projectKey: "q7",
      backup: null,
    });
  });
});
