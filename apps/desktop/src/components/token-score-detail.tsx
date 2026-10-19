import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { type Dispatch, type SetStateAction, useRef, useState } from "react";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";
import {
  type Criterion,
  type CriterionId,
  type FixId,
  type FixPreview,
  formatPoints,
  formatScore,
  formatValue,
  type ProfileScore,
  type Status,
  sortCriteria,
  type TokenScore,
  tokenScoreFix,
  tokenScoreFixPreview,
  tokenScoreUndo,
} from "@/lib/token-score.ts";
import { formatTokens } from "@/lib/usage.ts";

const text: Dict<{
  detailTitle: string;
  groupA: string;
  groupB: string;
  notCounted: string;
  points: (earned: string, max: string) => string;
  measured: string;
  full: string;
  zero: string;
  source: string;
  sources: Record<string, string>;
  userSet: string;
  itemPoints: (score: string) => string;
  status: Record<Status, string>;
  criteria: Record<CriterionId, string>;
  hints: Record<CriterionId, string>;
  hintLabel: string;
  items: Record<string, string>;
  warnings: Record<string, string>;
  reasons: Record<string, string>;
  cli: Record<string, string>;
  fixes: Record<FixId, { button: (profile: string) => string; title: string }>;
  pickProject: string;
  hideContext: string;
  contextTitle: string;
  noContext: string;
  working: string;
  previewLead: (profile: string) => string;
  noChanges: string;
  none: string;
  after: Record<string, string>;
  fixWarnings: Record<string, string>;
  cancel: string;
  apply: string;
  applying: string;
  next: string;
  aggressiveTitle: string;
  aggressiveBody: string;
  aggressiveKeep: string;
  aggressiveApply: string;
  applied: (fix: string, profile: string) => string;
  undo: string;
  undoing: string;
  projectGone: string;
}> = {
  vi: {
    detailTitle: "Chi tiết từng tiêu chí",
    groupA: "Cấu hình",
    groupB: "Số liệu phiên",
    notCounted: "Không tính vào điểm máy",
    points: (earned, max) => `${earned}/${max} điểm`,
    measured: "Đo được",
    full: "Đủ điểm",
    zero: "0 điểm",
    source: "Nguồn",
    sources: {
      settings: "file cấu hình",
      context: "/context của gói",
      sessions: "phiên 7 ngày",
      files: "file chỉ dẫn",
      tools: "công cụ trên máy",
    },
    userSet: "người dùng đặt",
    itemPoints: (score) => `${score}/1`,
    status: {
      ok: "Đủ điểm",
      partial: "Một phần",
      low: "Thấp",
      unknown: "Chưa đo",
      unsupported: "Chưa hỗ trợ",
    },
    criteria: {
      A1: "Trần ngữ cảnh, nén sớm",
      A2: "Trần output tool",
      A3: "File chỉ dẫn gọn",
      A4: "Tool, MCP, skill nạp sẵn",
      A5: "Chỉ mục code",
      A6: "Lọc output lệnh",
      A7: "Cache và phiên bản CLI",
      A8: "Model và effort mặc định",
      B1: "Ngữ cảnh đỉnh",
      B2: "Token ở phiên rất dài",
      B3: "Ngữ cảnh lượt đầu",
      B4: "Cache trúng",
      B5: "Token quy đổi mỗi lượt API",
      B6: "Output tool trung bình",
      B7: "Token trước lần sửa đầu",
    },
    hints: {
      A1: "Dùng /compact giữa các việc, /clear khi đổi việc.",
      A2: "Đọc file theo đoạn (Read có offset/limit) thay vì cat cả file.",
      A3: "Chuyển hướng dẫn chuyên biệt sang skill hoặc .claude/rules/ có paths:.",
      A4: "Tắt MCP không dùng; dùng CLI (gh, glab) thay MCP; đặt disable-model-invocation: true cho skill chỉ gọi tay.",
      A5: "Nhắc agent dùng codegraph_explore trước grep.",
      A6: "Tác dụng nhỏ với việc đọc code; chủ yếu giảm output của lệnh dài như test, build.",
      A7: "Không đổi model, effort, MCP giữa phiên; cập nhật CLI giữa các phiên.",
      A8: "Chọn model và effort theo việc.",
      B1: "Sửa A1; tách việc thành phiên ngắn.",
      B2: "Sửa A1; /clear giữa các việc không liên quan.",
      B3: "Sửa A3, A4.",
      B4: "Không sửa CLAUDE.md, đổi model hay MCP giữa phiên; kiểm A7.",
      B5: "Sửa A1, A2.",
      B6: "Sửa A2, A6; đọc file theo đoạn.",
      B7: "Sửa A5; nêu rõ file hay hàm trong prompt.",
    },
    hintLabel: "Gợi ý",
    items: {
      "A2.bash": "Output Bash",
      "A2.read": "Đọc file",
      "A2.mcp": "Output MCP",
      "A2.hook": "Hook cắt output của Hive",
      "A2.toolOutput": "Trần output tool",
      "A3.tokens": "Token chỉ dẫn mỗi phiên",
      "A3.truncated": "Không file nào bị CLI cắt",
      "A5.tool": "Có codegraph trong PATH",
      "A5.mcp": "Gói có MCP codegraph",
      "A5.index": "Dự án có .codegraph/",
      "A6.rtk": "rtk chạy được",
      "A6.hook": "Hook RTK trong gói",
      "A7.cache": "Không tắt prompt cache",
      "A7.version": "CLI đủ mới (≥ 2.1.296)",
      "A8.effort": "Effort mặc định vừa phải",
      "A8.subagent": "Subagent không dùng Opus",
      "A8.verbosity": "Verbosity không cao",
    },
    warnings: {
      claude_md_long: "CLAUDE.md dài hơn 200 dòng.",
      tool_search_off: "Tool search đang tắt nên mọi tool MCP nạp sẵn.",
      always_load: "Có MCP server đặt luôn nạp sẵn.",
      user_set: "Có giá trị do người dùng đặt; sửa nhanh không ghi đè.",
      auto_compact_off: "Tự nén ngữ cảnh đang tắt (DISABLE_AUTO_COMPACT).",
    },
    reasons: {
      not_enough_sessions: "Chưa đủ dữ liệu: cần ít nhất 5 phiên chính trong 7 ngày.",
      context_unavailable: "Không đọc được /context của gói (chưa đăng nhập hoặc quá hạn).",
      config_unreadable: "Không đọc được file cấu hình.",
      unsupported_cli: "CLI này chưa được hỗ trợ.",
      no_edit_sessions: "Chưa có phiên nào sửa file trong 7 ngày.",
      windows_rtk_unsupported: "RTK chưa dùng được trên Windows.",
      cli_version_unknown: "Chưa biết phiên bản CLI.",
      no_projects: "Chưa có dự án nào dùng trong 7 ngày.",
      no_token_logs: "CLI này không có log token.",
      codex_not_measured: "Codex chưa đo được tiêu chí này.",
      not_measured_yet: "Chưa đo được.",
      default: "Đang để mặc định của CLI.",
      context_not_measured: "Chưa đo /context. Lệnh này gọi model nên chỉ chạy khi bạn bấm đo; kết quả giữ 7 ngày.",
    },
    cli: { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", gemini: "Gemini" },
    fixes: {
      "optimizer.balanced": { button: (p) => `Bật tối ưu Cân bằng cho ${p}`, title: "Bật tối ưu mức Cân bằng" },
      "optimizer.rtk": { button: (p) => `Bật hook RTK cho ${p}`, title: "Bật hook RTK" },
      "optimizer.aggressive": { button: (p) => `Bật mức Mạnh cho ${p}…`, title: "Bật tối ưu mức Mạnh" },
      "tool.rtk": { button: () => "Cài rtk ở màn Môi trường", title: "Cài rtk" },
      "tool.codegraph": { button: () => "Cài codegraph ở màn Môi trường", title: "Cài codegraph" },
      "codegraph.mcp": { button: (p) => `Thêm MCP codegraph vào ${p}`, title: "Thêm MCP codegraph" },
      "codegraph.init": { button: () => "Lập chỉ mục codegraph", title: "Lập chỉ mục codegraph cho dự án" },
      "open.memory": { button: () => "Mở trong màn Memory", title: "Mở màn Memory" },
      "open.mcp": { button: () => "Xem MCP và skill đang nạp", title: "MCP và skill đang nạp" },
      "context.measure": { button: () => "Đo /context (tốn khoảng 50k token)", title: "Đo /context" },
    },
    pickProject: "Dự án cần lập chỉ mục",
    hideContext: "Ẩn danh sách",
    contextTitle: "Nhóm trong /context, tốn nhiều token nhất lên đầu",
    noContext: "Chưa đọc được /context của gói này.",
    working: "Đang chuẩn bị bản xem trước…",
    previewLead: (profile) =>
      `Gói ${profile}. Xem các thay đổi trước khi áp dụng; bạn hoàn tác được ngay sau đó bằng nút Hoàn tác.`,
    noChanges: "Không có thay đổi nào cần ghi.",
    none: "(chưa có)",
    after: { added: "đã thêm", indexed: "đã lập chỉ mục" },
    fixWarnings: {
      quality_may_change: "Chất lượng kết quả có thể khác.",
      context_grows: "Ngữ cảnh mỗi phiên tăng một chút vì thêm các tool của codegraph (tiêu chí A4).",
      long_running: "Lập chỉ mục có thể mất vài phút trên dự án lớn; app chờ tối đa 10 phút.",
    },
    cancel: "Huỷ",
    apply: "Áp dụng",
    applying: "Đang áp dụng…",
    next: "Tiếp tục",
    aggressiveTitle: "Bật mức Mạnh?",
    aggressiveBody:
      "Subagent sẽ chạy Sonnet thay vì model bạn chọn, trần output tool thấp hơn và mô tả MCP ngắn hơn. Chất lượng kết quả có thể khác. Hoàn tác được bằng bản sao lưu.",
    aggressiveKeep: "Giữ nguyên",
    aggressiveApply: "Bật mức Mạnh",
    applied: (fix, profile) => `Đã áp dụng: ${fix} (${profile}).`,
    undo: "Hoàn tác",
    undoing: "Đang hoàn tác…",
    projectGone: "Dự án này không còn trong danh sách điểm; hoàn tác ở màn Môi trường hoặc bằng lệnh codegraph.",
  },
  en: {
    detailTitle: "Details per criterion",
    groupA: "Configuration",
    groupB: "Session figures",
    notCounted: "Not counted in the machine score",
    points: (earned, max) => `${earned}/${max} pts`,
    measured: "Measured",
    full: "Full score",
    zero: "Zero score",
    source: "Source",
    sources: {
      settings: "config file",
      context: "profile /context",
      sessions: "7-day sessions",
      files: "instruction files",
      tools: "tools on this machine",
    },
    userSet: "set by user",
    itemPoints: (score) => `${score}/1`,
    status: {
      ok: "Full score",
      partial: "Partial",
      low: "Low",
      unknown: "Not measured",
      unsupported: "Unsupported",
    },
    criteria: {
      A1: "Context ceiling, early compaction",
      A2: "Tool output cap",
      A3: "Lean instruction files",
      A4: "Preloaded tools, MCP, skills",
      A5: "Code index",
      A6: "Command output filter",
      A7: "Cache and CLI version",
      A8: "Default model and effort",
      B1: "Peak context",
      B2: "Tokens in very long sessions",
      B3: "First-turn context",
      B4: "Cache hit rate",
      B5: "Weighted tokens per API call",
      B6: "Average tool output",
      B7: "Tokens before the first edit",
    },
    hints: {
      A1: "Use /compact between tasks and /clear when switching tasks.",
      A2: "Read files in ranges (Read with offset/limit) instead of cat-ing the whole file.",
      A3: "Move specialised instructions into skills or .claude/rules/ with paths:.",
      A4: "Turn off unused MCP; use CLIs (gh, glab) instead of MCP; set disable-model-invocation: true on skills you only call by hand.",
      A5: "Remind the agent to use codegraph_explore before grep.",
      A6: "Small effect on code reading; mostly trims long command output such as tests and builds.",
      A7: "Do not change model, effort or MCP mid-session; update the CLI between sessions.",
      A8: "Pick model and effort per task.",
      B1: "Fix A1; split work into shorter sessions.",
      B2: "Fix A1; /clear between unrelated tasks.",
      B3: "Fix A3, A4.",
      B4: "Do not edit CLAUDE.md or change model or MCP mid-session; check A7.",
      B5: "Fix A1, A2.",
      B6: "Fix A2, A6; read files in ranges.",
      B7: "Fix A5; name the file or function in the prompt.",
    },
    hintLabel: "Tip",
    items: {
      "A2.bash": "Bash output",
      "A2.read": "File read",
      "A2.mcp": "MCP output",
      "A2.hook": "Hive output-trimming hook",
      "A2.toolOutput": "Tool output cap",
      "A3.tokens": "Instruction tokens per session",
      "A3.truncated": "No file truncated by the CLI",
      "A5.tool": "codegraph on PATH",
      "A5.mcp": "Profile has the codegraph MCP",
      "A5.index": "Projects with .codegraph/",
      "A6.rtk": "rtk runs",
      "A6.hook": "RTK hook in profile",
      "A7.cache": "Prompt cache not disabled",
      "A7.version": "CLI new enough (≥ 2.1.296)",
      "A8.effort": "Moderate default effort",
      "A8.subagent": "Subagent not on Opus",
      "A8.verbosity": "Verbosity not high",
    },
    warnings: {
      claude_md_long: "CLAUDE.md is longer than 200 lines.",
      tool_search_off: "Tool search is off, so every MCP tool is preloaded.",
      always_load: "An MCP server is set to always load.",
      user_set: "Some values were set by the user; quick fixes do not overwrite them.",
      auto_compact_off: "Auto-compact is turned off (DISABLE_AUTO_COMPACT).",
    },
    reasons: {
      not_enough_sessions: "Not enough data: needs at least 5 main sessions in 7 days.",
      context_unavailable: "Could not read the profile's /context (not signed in or timed out).",
      config_unreadable: "Could not read the config file.",
      unsupported_cli: "This CLI is not supported yet.",
      no_edit_sessions: "No session edited files in the last 7 days.",
      windows_rtk_unsupported: "RTK is not available on Windows yet.",
      cli_version_unknown: "CLI version unknown.",
      no_projects: "No project used in the last 7 days.",
      no_token_logs: "This CLI has no token logs.",
      codex_not_measured: "Codex cannot measure this criterion yet.",
      not_measured_yet: "Not measured yet.",
      default: "Left at the CLI default.",
      context_not_measured:
        "/context has not been measured. It calls the model, so it only runs when you ask; the result is kept for 7 days.",
    },
    cli: { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", gemini: "Gemini" },
    fixes: {
      "optimizer.balanced": { button: (p) => `Enable Balanced optimizer for ${p}`, title: "Enable the Balanced level" },
      "optimizer.rtk": { button: (p) => `Enable the RTK hook for ${p}`, title: "Enable the RTK hook" },
      "optimizer.aggressive": { button: (p) => `Enable Aggressive for ${p}…`, title: "Enable the Aggressive level" },
      "tool.rtk": { button: () => "Install rtk in Environment", title: "Install rtk" },
      "tool.codegraph": { button: () => "Install codegraph in Environment", title: "Install codegraph" },
      "codegraph.mcp": { button: (p) => `Add the codegraph MCP to ${p}`, title: "Add the codegraph MCP" },
      "codegraph.init": { button: () => "Index with codegraph", title: "Index the project with codegraph" },
      "open.memory": { button: () => "Open in Memory", title: "Open Memory" },
      "open.mcp": { button: () => "Show loaded MCP and skills", title: "Loaded MCP and skills" },
      "context.measure": { button: () => "Measure /context (about 50k tokens)", title: "Measure /context" },
    },
    pickProject: "Project to index",
    hideContext: "Hide list",
    contextTitle: "Groups in /context, most tokens first",
    noContext: "Could not read this profile's /context.",
    working: "Preparing the preview…",
    previewLead: (profile) =>
      `Profile ${profile}. Review the changes before applying; you can undo right afterwards with Undo.`,
    noChanges: "Nothing to write.",
    none: "(none)",
    after: { added: "added", indexed: "indexed" },
    fixWarnings: {
      quality_may_change: "Result quality may differ.",
      context_grows: "Per-session context grows a little because codegraph's tools are added (criterion A4).",
      long_running: "Indexing can take several minutes on a large project; the app waits up to 10 minutes.",
    },
    cancel: "Cancel",
    apply: "Apply",
    applying: "Applying…",
    next: "Continue",
    aggressiveTitle: "Enable the Aggressive level?",
    aggressiveBody:
      "Subagents will run Sonnet instead of the model you picked, tool output caps get lower and MCP descriptions shorter. Result quality may differ. A backup lets you undo.",
    aggressiveKeep: "Keep as is",
    aggressiveApply: "Enable Aggressive",
    applied: (fix, profile) => `Applied: ${fix} (${profile}).`,
    undo: "Undo",
    undoing: "Undoing…",
    projectGone: "This project is no longer in the score; undo from Environment or with the codegraph command.",
  },
};

/** Gợi ý của màn Token (`tips()`) đặt dưới tiêu chí liên quan của các gói cùng CLI. */
export interface ExtraHint {
  cli: string;
  criterion: CriterionId;
  title: string;
  why: string;
}

/** Một sửa nhanh đã áp dụng trong phiên này; giữ đủ để hoàn tác. */
export interface AppliedFix {
  fixId: FixId;
  profileId: string;
  /** Đường dẫn rút gọn của dự án (khoá dự án đổi sau mỗi lần tính nên không giữ khoá). */
  projectPath: string | null;
  backup: string | null;
}

export const profileName = (p: ProfileScore) => p.label ?? p.id;

/** Hộp xác nhận đang mở. `loading` chưa vẽ hộp; `applying` khoá nút trong lúc ghi. */
interface Flow {
  fixId: FixId;
  profileId: string;
  projectKey: string | null;
  step: "loading" | "preview" | "confirm" | "applying";
  from: "preview" | "confirm";
  preview?: FixPreview;
  error?: string | undefined;
}

const NAV_FIXES: Partial<Record<FixId, string>> = {
  "tool.rtk": "#/setup",
  "tool.codegraph": "#/setup",
  "open.memory": "#/memory",
};

interface DetailProps {
  score: TokenScore;
  hints?: ExtraHint[];
  /** Sau khi sửa nhanh xong: để nơi giữ điểm tính lại. */
  onChanged: () => void | Promise<void>;
  onApplied: (fix: AppliedFix) => void;
  /** Đo lại /context cho mọi gói (gọi model, tốn token): chỉ chạy khi người dùng bấm. */
  onMeasureContext?: () => void;
}

/** Chi tiết điểm: tiêu chí của từng gói xếp theo điểm thiếu, kèm gợi ý và nút sửa nhanh có xem trước. */
export function TokenScoreDetail({ score, hints = [], onChanged, onApplied, onMeasureContext }: DetailProps) {
  const t = useT(text);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const busy = flow !== null;

  async function start(fixId: FixId, profileId: string, projectKey: string | null) {
    if (busy) return;
    // Không ghi cấu hình nào: chỉ chấm lại có kèm /context.
    if (fixId === "context.measure") {
      onMeasureContext?.();
      return;
    }
    const id = ++seq.current;
    setError(null);
    setFlow({ fixId, profileId, projectKey, step: "loading", from: "preview" });
    try {
      const preview = await tokenScoreFixPreview(fixId, profileId, projectKey);
      if (seq.current === id) setFlow({ fixId, profileId, projectKey, step: "preview", from: "preview", preview });
    } catch (e) {
      if (seq.current !== id) return;
      setFlow(null);
      setError(errorText(e));
    }
  }

  function close() {
    if (flow?.step === "applying") return;
    seq.current++;
    setFlow(null);
  }

  async function apply(from: "preview" | "confirm") {
    if (!flow) return;
    const current = flow;
    setFlow({ ...current, step: "applying", from, error: undefined });
    try {
      const result = await tokenScoreFix(current.fixId, current.profileId, current.projectKey);
      const profile = score.profiles.find((p) => p.id === current.profileId);
      const project = profile?.projects.find((p) => p.key === current.projectKey);
      onApplied({
        fixId: current.fixId,
        profileId: current.profileId,
        projectPath: project?.path ?? null,
        backup: result.backup ?? null,
      });
      seq.current++;
      setFlow(null);
      await onChanged();
    } catch (e) {
      setFlow({ ...current, step: from, error: errorText(e) });
    }
  }

  const profile = flow ? score.profiles.find((p) => p.id === flow.profileId) : undefined;
  const aggressive = flow?.fixId === "optimizer.aggressive";
  // Trong lúc ghi, hộp vẫn là hộp mà người dùng vừa bấm "Áp dụng".
  const view = flow?.step === "applying" ? flow.from : flow?.step;
  const keepRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex flex-col gap-5 border-t px-4 py-3.5">
      <h3 className="sr-only">{t.detailTitle}</h3>
      {error && <Alert variant="destructive">{error}</Alert>}
      {flow?.step === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          {t.working}
        </p>
      )}
      {score.profiles.map((p) => (
        <ProfileSection key={p.id} profile={p} hints={hints} busy={busy} onFix={start} />
      ))}

      <Dialog open={view === "preview"} onOpenChange={(open) => !open && close()}>
        <DialogContent className="max-h-[85vh] gap-3.5 overflow-y-auto p-5 sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle className="text-[17px] font-semibold">{flow ? t.fixes[flow.fixId].title : ""}</DialogTitle>
            <DialogDescription className="text-sm">
              {profile ? t.previewLead(profileName(profile)) : ""}
            </DialogDescription>
          </DialogHeader>
          {flow?.error && <Alert variant="destructive">{flow.error}</Alert>}
          {flow?.preview && <PreviewBody preview={flow.preview} />}
          <DialogActions>
            <Button variant="outline" onClick={close} disabled={flow?.step === "applying"}>
              {t.cancel}
            </Button>
            {aggressive ? (
              <Button
                onClick={() => flow && setFlow({ ...flow, step: "confirm", from: "confirm", error: undefined })}
                disabled={!flow?.preview}
              >
                {t.next}
              </Button>
            ) : (
              <Button onClick={() => void apply("preview")} disabled={!flow?.preview || flow.step === "applying"}>
                {flow?.step === "applying" ? t.applying : t.apply}
              </Button>
            )}
          </DialogActions>
        </DialogContent>
      </Dialog>

      <Dialog open={view === "confirm"} onOpenChange={(open) => !open && close()}>
        <DialogContent initialFocus={keepRef} className="gap-3.5 p-5 sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="text-[17px] font-semibold">{t.aggressiveTitle}</DialogTitle>
            <DialogDescription className="text-sm">{profile ? profileName(profile) : ""}</DialogDescription>
          </DialogHeader>
          <Alert>{t.aggressiveBody}</Alert>
          {flow?.preview?.warnings.map((w) => (
            <p key={w} className="text-sm text-warning">
              {t.fixWarnings[w] ?? w}
            </p>
          ))}
          {flow?.error && <Alert variant="destructive">{flow.error}</Alert>}
          {/* Giữ nguyên là nút được focus và có màu chính: Enter và nhấn nhầm không bật mức Mạnh. */}
          <DialogActions>
            <Button ref={keepRef} onClick={close} disabled={flow?.step === "applying"}>
              {t.aggressiveKeep}
            </Button>
            <Button variant="outline" onClick={() => void apply("confirm")} disabled={flow?.step === "applying"}>
              {flow?.step === "applying" ? t.applying : t.aggressiveApply}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PreviewBody({ preview }: { preview: FixPreview }) {
  const t = useT(text);
  return (
    <>
      {preview.changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.noChanges}</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {preview.changes.map((c) => (
            <li key={`${c.file}\n${c.key}`} className="flex flex-col gap-0.5 rounded-lg bg-muted px-3 py-2 text-sm">
              <span className="font-mono text-xs break-all text-muted-foreground">{c.file}</span>
              <span className="font-mono text-xs break-all">{c.key}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground line-through">{c.before ?? t.none}</span>
                <span>→</span>
                <span className="font-medium">{c.after === null ? t.none : (t.after[c.after] ?? c.after)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {preview.warnings.map((w) => (
        <p key={w} className="text-sm text-warning">
          {t.fixWarnings[w] ?? w}
        </p>
      ))}
    </>
  );
}

function ProfileSection({
  profile,
  hints,
  busy,
  onFix,
}: {
  profile: ProfileScore;
  hints: ExtraHint[];
  busy: boolean;
  onFix: (fixId: FixId, profileId: string, projectKey: string | null) => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const rows = sortCriteria(profile.criteria);
  const fmt = (n: number) => formatScore(n, lang);
  const pts = (n: number) => formatPoints(n, lang);
  return (
    <section aria-label={`${t.cli[profile.cli] ?? profile.cli} ${profileName(profile)}`} className="flex flex-col">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pb-1">
        <h4 className="text-sm font-semibold">
          {t.cli[profile.cli] ?? profile.cli} · {profileName(profile)}
        </h4>
        {profile.score !== null && <span className="font-mono text-sm">{fmt(profile.score)}</span>}
        <span className="text-xs text-muted-foreground">
          {t.groupA} {pts(profile.groups.A.earned)}/{pts(profile.groups.A.max)} · {t.groupB}{" "}
          {pts(profile.groups.B.earned)}/{pts(profile.groups.B.max)}
        </span>
        {!profile.counted && <Pill small>{t.notCounted}</Pill>}
      </header>
      <ol>
        {rows.map((c) => (
          <CriterionRow
            key={c.id}
            profile={profile}
            criterion={c}
            hints={hints.filter((h) => h.cli === profile.cli && h.criterion === c.id)}
            busy={busy}
            onFix={onFix}
          />
        ))}
      </ol>
    </section>
  );
}

const STATUS_TONE = { ok: "ok", partial: "warn", low: "bad", unknown: "neutral", unsupported: "neutral" } as const;

/** Mốc "đủ điểm" và "0 điểm" kèm chiều: giá trị thấp là tốt khi mức đủ điểm nhỏ hơn mức 0 điểm. */
function Thresholds({ c }: { c: Criterion }) {
  const t = useT(text);
  const lang = useLang();
  if (c.good === undefined || c.bad === undefined) return null;
  const lowerBetter = c.good <= c.bad;
  return (
    <span>
      {t.full} {lowerBetter ? "≤" : "≥"} {formatValue(c.good, c.unit, lang)} · {t.zero} {lowerBetter ? "≥" : "≤"}{" "}
      {formatValue(c.bad, c.unit, lang)}
    </span>
  );
}

function CriterionRow({
  profile,
  criterion: c,
  hints,
  busy,
  onFix,
}: {
  profile: ProfileScore;
  criterion: Criterion;
  hints: ExtraHint[];
  busy: boolean;
  onFix: (fixId: FixId, profileId: string, projectKey: string | null) => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const [showContext, setShowContext] = useState(false);
  const fmt = (n: number) => formatPoints(n, lang);
  const measured = c.status !== "unknown" && c.status !== "unsupported";
  const needsWork = c.status !== "ok" && c.status !== "unsupported";
  const reason = c.reason ? (t.reasons[c.reason] ?? c.reason) : undefined;
  const fixes = needsWork ? (c.fixes ?? []) : [];
  return (
    <li data-criterion={c.id} className="flex flex-col gap-1.5 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs text-muted-foreground">{c.id}</span>
        <strong className="text-sm font-semibold">{t.criteria[c.id]}</strong>
        <Pill small tone={STATUS_TONE[c.status]}>
          {t.status[c.status]}
        </Pill>
        {c.userSet && (
          <Pill small tone="sel">
            {t.userSet}
          </Pill>
        )}
        <span className="ml-auto font-mono text-sm">{t.points(fmt(c.earned), fmt(c.max))}</span>
      </div>

      {measured && c.value !== undefined && (
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
          <span>
            {t.measured}: <span className="font-mono font-medium">{formatValue(c.value, c.unit, lang)}</span>
          </span>
          <span className="text-xs text-muted-foreground">
            <Thresholds c={c} />
          </span>
        </p>
      )}
      {measured && c.value === undefined && c.good !== undefined && (
        <p className="text-xs text-muted-foreground">
          <Thresholds c={c} />
        </p>
      )}
      {c.source && (
        <p className="text-xs text-muted-foreground">
          {t.source}: {t.sources[c.source] ?? c.source}
        </p>
      )}
      {reason && !measured && <p className="text-sm text-muted-foreground">{reason}</p>}

      {c.items && c.items.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs">
          {c.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-2">
              <span>{t.items[`${c.id}.${item.id}`] ?? item.id}</span>
              {item.value !== undefined && (
                <span className="font-mono text-muted-foreground">
                  {item.value >= 1000 ? formatTokens(item.value, lang) : item.value.toLocaleString(lang)}
                </span>
              )}
              {item.score !== undefined ? (
                <span className="font-mono text-muted-foreground">{t.itemPoints(fmt(item.score))}</span>
              ) : (
                item.reason && <span className="text-muted-foreground">{t.reasons[item.reason] ?? item.reason}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {c.warnings?.map((w) => (
        <p key={`${w.code}\n${w.file ?? ""}`} className="text-xs text-warning">
          {t.warnings[w.code] ?? w.code}
          {w.file && <span className="font-mono"> {w.file}</span>}
        </p>
      ))}
      {needsWork && measured && <p className="text-xs text-muted-foreground">{t.hints[c.id]}</p>}
      {hints.map((h) => (
        <p key={h.title} className="rounded-lg bg-muted px-3 py-2 text-sm">
          <strong className="font-semibold">{h.title}.</strong> <span className="text-muted-foreground">{h.why}</span>
        </p>
      ))}

      {fixes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {fixes.map((fixId) => (
            <FixControl
              key={fixId}
              fixId={fixId}
              profile={profile}
              busy={busy}
              contextOpen={showContext}
              onToggleContext={() => setShowContext((v) => !v)}
              onFix={onFix}
            />
          ))}
        </div>
      )}
      {showContext && fixes.includes("open.mcp") && <ContextList profile={profile} />}
    </li>
  );
}

function ContextList({ profile }: { profile: ProfileScore }) {
  const t = useT(text);
  const lang = useLang();
  const groups = [...(profile.context ?? [])].sort((a, b) => b.tokens - a.tokens);
  return (
    <div className="rounded-lg bg-muted px-3 py-2 text-sm">
      <p className="pb-1 text-xs text-muted-foreground">{t.contextTitle}</p>
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.noContext}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {groups.map((g) => (
            <li key={g.name} className="flex items-center gap-2">
              <span className="flex-1">{g.name}</span>
              <span className="font-mono text-xs">{formatTokens(g.tokens, lang)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FixControl({
  fixId,
  profile,
  busy,
  contextOpen,
  onToggleContext,
  onFix,
}: {
  fixId: FixId;
  profile: ProfileScore;
  busy: boolean;
  contextOpen: boolean;
  onToggleContext: () => void;
  onFix: (fixId: FixId, profileId: string, projectKey: string | null) => void;
}) {
  const t = useT(text);
  // Chỉ dự án chưa có `.codegraph/` mới cần lập chỉ mục.
  const candidates = profile.projects.filter((p) => !p.codegraph);
  const [picked, setPicked] = useState("");
  const label = t.fixes[fixId].button(profileName(profile));

  if (fixId === "open.mcp") {
    return (
      <Button variant="outline" size="sm" aria-expanded={contextOpen} onClick={onToggleContext}>
        {contextOpen ? t.hideContext : label}
      </Button>
    );
  }
  const href = NAV_FIXES[fixId];
  if (href) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          location.hash = href;
        }}
      >
        {label}
      </Button>
    );
  }
  if (fixId === "codegraph.init") {
    if (candidates.length === 0) return null;
    const key = candidates.some((p) => p.key === picked) ? picked : (candidates[0]?.key ?? "");
    return (
      <span className="flex flex-wrap items-center gap-2">
        {candidates.length > 1 && (
          <select
            aria-label={t.pickProject}
            value={key}
            disabled={busy}
            className="max-w-full rounded-md border bg-background px-2 py-1 text-sm"
            onChange={(e) => setPicked(e.target.value)}
          >
            {candidates.map((p) => (
              <option key={p.key} value={p.key}>
                {p.path}
              </option>
            ))}
          </select>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onFix(fixId, profile.id, key)}>
          {candidates.length === 1 ? `${label}: ${candidates[0]?.path}` : label}
        </Button>
      </span>
    );
  }
  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => onFix(fixId, profile.id, null)}>
      {label}
    </Button>
  );
}

/** Các sửa nhanh đã áp dụng, mỗi cái có nút Hoàn tác; điểm tính lại sau khi hoàn tác. */
export function AppliedFixes({
  score,
  applied,
  setApplied,
  onChanged,
}: {
  score: TokenScore;
  applied: AppliedFix[];
  setApplied: Dispatch<SetStateAction<AppliedFix[]>>;
  onChanged: () => void | Promise<void>;
}) {
  const t = useT(text);
  const [undoing, setUndoing] = useState<AppliedFix | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (applied.length === 0 && !error) return null;

  async function undo(entry: AppliedFix) {
    if (undoing) return;
    setUndoing(entry);
    setError(null);
    try {
      const profile = score.profiles.find((p) => p.id === entry.profileId);
      // Khoá dự án đổi sau mỗi lần tính điểm nên tra lại theo đường dẫn của kết quả mới nhất.
      const key = entry.projectPath ? (profile?.projects.find((p) => p.path === entry.projectPath)?.key ?? null) : null;
      if (entry.projectPath && !key) throw new Error(t.projectGone);
      await tokenScoreUndo(entry.fixId, entry.profileId, key, entry.backup);
      setApplied((list) => list.filter((x) => x !== entry));
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUndoing(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {error && <Alert variant="destructive">{error}</Alert>}
      {applied.map((entry) => {
        const profile = score.profiles.find((p) => p.id === entry.profileId);
        return (
          <div
            key={`${entry.fixId}\n${entry.profileId}\n${entry.projectPath ?? ""}`}
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-lg bg-success-soft px-3 py-2 text-sm text-success"
          >
            <span className="min-w-40 flex-1">
              {t.applied(t.fixes[entry.fixId].title, profile ? profileName(profile) : entry.profileId)}
            </span>
            <Button variant="outline" size="sm" disabled={undoing !== null} onClick={() => void undo(entry)}>
              {undoing === entry ? t.undoing : t.undo}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
