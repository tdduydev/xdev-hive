import { z } from "zod";
import { id, orgRoute } from "./common.ts";
import { machineLabel } from "./fleet.ts";
import { parseRepoUrl } from "./repo-url.ts";
import { repoOwner, scmKind } from "./scm.ts";
import { cli } from "./worker-protocol.ts";

/** Agent dùng key này khi gọi MCP và nó nằm trong AGENTS.md, nên chỉ cho ký tự an toàn với URL và shell. */
export const projectKey = z
  .string()
  .min(2, "Project key cần ít nhất 2 ký tự.")
  .max(40, "Project key dài tối đa 40 ký tự.")
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    "Project key gồm chữ thường, số và gạch ngang, bắt đầu bằng chữ, không có hai gạch liền nhau.",
  );

const repoName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, "Tên repo chỉ gồm chữ, số, `.`, `_`, `-`.")
  .refine((n) => n !== "." && n !== ".." && !n.endsWith(".git"), "Tên repo không hợp lệ.");
const branch = z.string().regex(/^(?!\/)(?!.*\.\.)(?!.*\/\/)[\w./-]{1,200}(?<![/.])$/, "Tên nhánh không hợp lệ.");

export const repoVisibility = z.enum(["private", "internal", "public"]);

const newRepo = z.object({
  mode: z.literal("new"),
  connectionId: id,
  owner: repoOwner,
  name: repoName,
  visibility: repoVisibility.default("private"),
  defaultBranch: branch.default("main"),
  description: z.string().max(300).optional(),
});
const existingRepo = z.object({
  mode: z.literal("existing"),
  connectionId: id,
  url: z
    .string()
    .max(500)
    .refine((u) => parseRepoUrl(u) !== null, "URL repo phải là https hoặc ssh, không kèm token hay mật khẩu."),
});

export const projectCreateInput = z.object({
  systemId: id,
  key: projectKey,
  name: z.string().trim().min(1, "Tên dự án không được để trống.").max(100, "Tên dự án dài tối đa 100 ký tự."),
  repo: z.discriminatedUnion("mode", [newRepo, existingRepo]),
  protection: z
    .object({
      protectDefault: z.boolean().default(true),
      requiredApprovals: z.number().int().min(0).max(6).default(1),
    })
    .default({ protectDefault: true, requiredApprovals: 1 }),
  webhook: z.boolean().default(true),
  /** Mỗi lần mở form tạo một khoá; gửi lại cùng khoá trả về dự án đã tạo, không tạo trùng. */
  idempotencyKey: z.uuid("Khoá chống trùng phải là UUID."),
  /** Chỉ kiểm quyền và trả kế hoạch, chưa ghi gì. */
  dryRun: z.boolean().default(false),
});
export type ProjectCreateInput = z.input<typeof projectCreateInput>;
/** Đầu vào sau khi zod điền mặc định; hub làm việc với kiểu này. */
export type ProjectCreateRequest = z.output<typeof projectCreateInput>;

// Chính sách kết quả theo docs/decisions.md ("Đề xuất: điều kiện thành công của run cấu hình động").
const required = z.boolean().default(true);
export const outcomeCheck = z.discriminatedUnion("check", [
  z.object({
    check: z.literal("changes"),
    required,
    maxFiles: z.number().int().positive().optional(),
    deny: z.array(z.string().max(200)).max(50).optional(),
  }),
  z.object({ check: z.literal("agentReport"), required }),
  z.object({
    check: z.literal("command"),
    required,
    run: z.string().min(1).max(500),
    timeout: z
      .string()
      .regex(/^\d+(s|m|h)$/)
      .default("15m"),
  }),
  z.object({
    check: z.literal("review"),
    required,
    by: z.enum(["claude", "codex", "gemini"]),
    minScore: z.number().min(0).max(10).default(7),
    when: z
      .object({
        minChangedLines: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        paths: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
      })
      .refine(
        (w) => w.minChangedLines !== undefined || w.paths !== undefined,
        "Điều kiện review cần ngưỡng số dòng hoặc đường dẫn.",
      )
      .optional(),
  }),
  z.object({ check: z.literal("ci"), required }),
]);
export type OutcomeCheck = z.output<typeof outcomeCheck>;

export const issueIntakeSettings = z.object({
  enabled: z.boolean(),
  /** Nhãn GitHub/GitLab có thể chứa khoảng trắng (`good first issue`). */
  label: z.string().trim().min(1).max(100),
  /** Tên bot được nhắc trong bình luận, không có `@`. */
  mention: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/, "Tên chỉ gồm chữ, số, dấu chấm, gạch dưới, gạch ngang"),
});
export type IssueIntake = z.output<typeof issueIntakeSettings>;

/** Tắt như mọi tính năng mới trong `features`: dự án phải chủ động bật mới nhận việc từ issue. */
export const defaultIssueIntake: IssueIntake = { enabled: false, label: "hive", mention: "hive" };

/**
 * Cài đặt "Tiết kiệm token" cho run Claude Code (worker đặt thành biến môi trường của CLI). Bật mặc định vì số đo
 * trên máy dev cho thấy output Bash, subagent chạy model nặng và ghi cache 1 giờ là các khoản tốn nhất; dự án nào
 * cần ngữ cảnh đầy đủ thì tắt hoặc chỉnh từng mục. Các biến môi trường và RTK chỉ áp cho Claude Code; CodeGraph áp cho
 * cả Codex, Gemini và Antigravity. `enabled` là công tắc tổng: tắt thì worker không áp mục nào, kể cả rtk và codegraph.
 */
const tokenSavingShape = {
  enabled: z.boolean(),
  /** Số ký tự tối đa của output một lệnh Bash đưa vào ngữ cảnh (BASH_MAX_OUTPUT_LENGTH). */
  bashMaxChars: z
    .number("Nhập một số.")
    .int("Nhập số nguyên.")
    .min(1000, "Tối thiểu 1.000 ký tự.")
    .max(150_000, "Tối đa 150.000 ký tự."),
  /** Phần trăm ngữ cảnh khiến Claude Code tự nén (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE); chỉ hạ được ngưỡng. */
  autocompactPct: z.number("Nhập một số.").int("Nhập số nguyên.").min(1, "Từ 1 đến 100.").max(100, "Từ 1 đến 100."),
  /** Model của subagent (CLAUDE_CODE_SUBAGENT_MODEL), vd `sonnet`, `haiku`. */
  subagentModel: z.string().trim().min(1, "Nhập tên model.").max(100, "Tối đa 100 ký tự."),
  /** Thời gian giữ cache prompt: `5m` rẻ hơn khi các lượt cách nhau ngắn, `1h` cho run có lượt chờ dài. */
  cacheTtl: z.enum(["5m", "1h"]),
  /**
   * Cửa sổ ngữ cảnh tối đa (token) trước khi Claude Code nén (CLAUDE_CODE_AUTO_COMPACT_WINDOW): chặn phiên phình gần
   * 1 triệu token, vì mỗi lượt đọc lại cả ngữ cảnh.
   */
  autocompactWindow: z
    .number("Nhập một số.")
    .int("Nhập số nguyên.")
    .min(50_000, "Tối thiểu 50.000 token.")
    .max(1_000_000, "Tối đa 1.000.000 token."),
  /** Cho agent dùng web (WebFetch, WebSearch; web_search của Codex). Tắt mặc định: run code hiếm khi cần. */
  allowWeb: z.boolean(),
  /** Nén output lệnh Bash qua RTK khi máy chạy run có rtk; chỉ Claude Code. */
  rtk: z.boolean(),
  /** Gắn MCP CodeGraph (`codegraph_explore`) và giữ chỉ mục code khi máy chạy run có codegraph. */
  codegraph: z.boolean(),
  /**
   * Worker dựng sẵn danh sách file liên quan tới task (đường dẫn, symbol nhắc tới, file hay đổi cùng trong git log, tìm
   * theo từ khoá) và tiêm vào đầu run, vì agent tốn phần lớn chi phí để dò repo trước lần sửa đầu. Mọi CLI.
   */
  contextPack: z.boolean(),
  /** Số lệnh dò repo (find, ls -R, grep -r…) được chạy trước lần sửa đầu; quá thì hook từ chối. 0 là tắt; chỉ Claude Code. */
  exploreBudget: z.number("Nhập một số.").int("Nhập số nguyên.").min(0, "Từ 0 đến 50.").max(50, "Từ 0 đến 50."),
  /** Output một tool dài hơn chừng này ký tự thì bị cắt (giữ đầu, cuối, dòng lỗi). 0 là tắt; chỉ Claude Code. */
  toolOutputMaxChars: z
    .number("Nhập một số.")
    .int("Nhập số nguyên.")
    .min(0, "Nhập 0 (tắt) hoặc từ 2.000 ký tự.")
    .max(200_000, "Tối đa 200.000 ký tự.")
    .refine((v) => v === 0 || v >= 2000, "Nhập 0 (tắt) hoặc từ 2.000 ký tự."),
};

// rtk và codegraph có mặc định vì settings đã lưu trước khi có hai mục này không chứa chúng. Mặc định chỉ đặt ở bản
// đầy đủ: nếu đặt trong shape chung thì `.partial()` của bản vá vẫn điền true khi trường vắng, và một bản vá chỉ đổi
// bashMaxChars sẽ lặng lẽ bật lại mục người dùng đã tắt.
export const tokenSavingSettings = z.object({
  ...tokenSavingShape,
  rtk: tokenSavingShape.rtk.default(true),
  codegraph: tokenSavingShape.codegraph.default(true),
});
export const tokenSavingPatch = z.object(tokenSavingShape).partial().strict();
export type TokenSaving = z.output<typeof tokenSavingSettings>;

/**
 * Dạng đọc từ settings đã lưu: mục thêm sau có mặc định để dự án lưu trước đó vẫn hợp lệ. Bản vá dùng
 * tokenSavingSettings không có mặc định, vì `.partial()` của trường có mặc định vẫn điền mặc định và đè giá trị đã lưu.
 */
const storedTokenSaving = tokenSavingSettings.extend({
  autocompactWindow: tokenSavingSettings.shape.autocompactWindow.default(200_000),
  allowWeb: tokenSavingSettings.shape.allowWeb.default(false),
  contextPack: tokenSavingSettings.shape.contextPack.default(true),
  exploreBudget: tokenSavingSettings.shape.exploreBudget.default(4),
  toolOutputMaxChars: tokenSavingSettings.shape.toolOutputMaxChars.default(12_000),
});

export const defaultTokenSaving: TokenSaving = {
  enabled: true,
  bashMaxChars: 15_000,
  autocompactPct: 70,
  subagentModel: "sonnet",
  cacheTtl: "5m",
  autocompactWindow: 200_000,
  allowWeb: false,
  rtk: true,
  codegraph: true,
  contextPack: true,
  exploreBudget: 4,
  toolOutputMaxChars: 12_000,
};

/** Cấp độ task: nhẹ (chữ, tài liệu, sửa nhỏ), vừa (một màn, CRUD), nặng (nhiều module, giao thức, bảo mật). */
export const taskTier = z.enum(["light", "medium", "heavy"]);
export type TaskTier = z.output<typeof taskTier>;
export const TASK_TIERS: readonly TaskTier[] = taskTier.options;

/** Mức effort chung của Claude Code (`--effort`) và Codex (`model_reasoning_effort`). */
export const routingEffort = z.enum(["low", "medium", "high"]);
export type RoutingEffort = z.output<typeof routingEffort>;

export const tierRoute = z.object({
  /** Model của Claude Code cho cấp này; CLI khác giữ model đã cấu hình (tên model mỗi CLI một kiểu). */
  model: z.string().trim().min(1, "Nhập tên model.").max(100, "Tối đa 100 ký tự."),
  effort: routingEffort,
  /** `--max-turns` của Claude Code; dự án đặt budget.maxTurns thì giá trị đó thắng. */
  maxTurns: z
    .number("Nhập một số.")
    .int("Nhập số nguyên.")
    .min(1, "Tối thiểu 1 lượt.")
    .max(10_000, "Tối đa 10.000 lượt."),
  /** Model cố vấn (`--advisor`): Claude Code chạy `model` và chỉ hỏi cố vấn ở điểm quyết định; null là tắt. */
  advisor: z.string().trim().min(1).max(100).nullable(),
});
export type TierRoute = z.output<typeof tierRoute>;

/**
 * Định tuyến model và effort theo cấp độ task cho run code (số đo: Opus chiếm 92% chi phí). Run review, plan, brief
 * giữ model theo loại run như trước. Cấp độ suy từ nhãn, loại task, cỡ kế hoạch và mô tả; run thử lại sau lỗi lên
 * một cấp.
 */
export const routingSettings = z.object({
  enabled: z.boolean(),
  tiers: z.object({ light: tierRoute, medium: tierRoute, heavy: tierRoute }),
});
export type RoutingSettings = z.output<typeof routingSettings>;

export const defaultRouting: RoutingSettings = {
  enabled: true,
  tiers: {
    light: { model: "sonnet", effort: "medium", maxTurns: 60, advisor: null },
    medium: { model: "sonnet", effort: "high", maxTurns: 120, advisor: null },
    heavy: { model: "opus", effort: "high", maxTurns: 200, advisor: null },
  },
};

export const runPermissionMode = z.enum(["workspace", "full"]);
/**
 * Trần chi phí của dự án. Mỗi trường bỏ trống là không giới hạn. Worker dừng run vượt trần như khi huỷ; hub từ chối
 * giao thêm run cho task đã tiêu hết perTaskUsd. Codex không báo USD nên trần USD chỉ có tác dụng với Claude; dùng
 * perRunTokens để giới hạn CLI khác.
 */
export const projectBudget = z.object({
  perRunUsd: z.number().positive().max(100_000).optional(),
  perTaskUsd: z.number().positive().max(100_000).optional(),
  maxTurns: z.number().int().min(1).max(10_000).optional(),
  /** Token input + output + ghi cache của một run (không tính đọc cache). */
  perRunTokens: z.number().int().min(1).max(1_000_000_000).optional(),
});
export type ProjectBudget = z.output<typeof projectBudget>;

// Cài đặt AI SDLC của dự án nằm ở đây chứ không ở sdlc.ts: sdlc.ts cần workflows.ts, mà workflows.ts import file này,
// nên đặt ở sdlc.ts sẽ thành vòng import và zod gặp biến chưa khởi tạo khi nạp module.

/** Mức chặn run code của task thuộc hạng mục khi tài liệu bắt buộc chưa duyệt (specs/011 FR-028). */
export const sdlcBlocking = z.enum(["hard", "soft", "none"]);
export type SdlcBlocking = z.output<typeof sdlcBlocking>;
/** Thứ tự từ lỏng tới chặt, để lấy mức chặt nhất của chế độ và dự án. */
export const SDLC_BLOCKING_ORDER: readonly SdlcBlocking[] = ["none", "soft", "hard"];

/** Glob đường dẫn theo `matchGlob` (glob.ts). */
const pathGlob = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\\]+$/, "Glob dùng dấu / thay cho dấu \\.");

/**
 * Tự duyệt AI ở lớp dự án (specs/011 D26, FR-057): chỉ siết thêm so với chế độ. Kiểm lúc xét chứ không lúc lưu, vì mỗi
 * hạng mục chụp một chế độ khác nhau. Mặc định tắt.
 */
export const projectSdlcAutoApprove = z.object({
  enabled: z.boolean().default(false),
  /** Chỉ có tác dụng khi cao hơn ngưỡng của chế độ. */
  minScore: z.number().min(0).max(10).optional(),
  /** Id giai đoạn được tự duyệt; bỏ trống là mọi giai đoạn chế độ cho phép. */
  phases: z.array(z.string().max(40)).max(12).optional(),
  /** Chỉ có tác dụng khi dài hơn hạn thu hồi của chế độ. */
  revokeHours: z.number().int().min(1).max(168).optional(),
  denyPaths: z.array(pathGlob).max(50).default([]),
  denyKeywords: z.array(z.string().trim().min(1).max(60)).max(100).default([]),
});

/** `project.settings.sdlc` (specs/011 FR-005). Dự án chưa có mục này coi như chưa bật AI SDLC. */
export const projectSdlcSettings = z.object({
  enabled: z.boolean().default(false),
  /** Id preset hoặc slug chế độ tự tạo. */
  defaultMode: z.string().max(80).nullable().default(null),
  /** Chế độ được dùng; rỗng là chỉ chế độ mặc định. */
  modes: z.array(z.string().max(80)).max(20).default([]),
  /** Chỉ có tác dụng khi chặt hơn chế độ. */
  blocking: sdlcBlocking.optional(),
  repoSync: z.enum(["pr", "direct", "off"]).default("pr"),
  /** Thư mục gốc tài liệu trong repo; bỏ trống là đường dẫn của chế độ. */
  docsRoot: z
    .string()
    .max(120)
    .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]*$/, "Thư mục tài liệu phải là đường dẫn tương đối trong repo.")
    .optional(),
  maxParallel: z.number().int().min(1).max(10).default(2),
  autoRunWaves: z.boolean().default(false),
  /** `team`: máy dùng chung của đội (run không chủ); `requester`: máy của người bấm (ADR 0017). */
  runner: z.enum(["team", "requester"]).default("team"),
  /** Nhãn máy run AI SDLC và run code của task hạng mục yêu cầu. */
  labels: z.array(machineLabel).max(5).default([]),
  /** Từ khoá rủi ro cho gợi ý cỡ việc. */
  riskKeywords: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
  autoApprove: projectSdlcAutoApprove.prefault({}),
});
export type ProjectSdlcSettings = z.output<typeof projectSdlcSettings>;
export type ProjectSdlcSettingsInput = z.input<typeof projectSdlcSettings>;

/**
 * Bản tóm tắt repo cho mọi run (ADR 0022). `auto`: hub tự giao run `brief` khi dự án chưa có brief, khi nhánh chính
 * đã đi trước brief `refreshCommits` commit, hoặc khi brief cũ hơn `refreshDays` ngày. Tắt thì chỉ người bấm "Làm mới"
 * hay sửa tay; brief đã có vẫn vào prompt.
 */
export const briefSettings = z.object({
  auto: z.boolean(),
  refreshCommits: z.number().int().min(1).max(10_000),
  refreshDays: z.number().int().min(1).max(365),
});
export type BriefSettings = z.output<typeof briefSettings>;
export const DEFAULT_BRIEF_SETTINGS: BriefSettings = { auto: true, refreshCommits: 50, refreshDays: 7 };

export const mergeMethod = z.enum(["merge", "squash", "rebase"]);
export type MergeMethod = z.output<typeof mergeMethod>;

/** Đường dẫn Git giữ nguyên Unicode nhưng không được thoát khỏi repo. */
export const docRepoPath = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/[\\:]/.test(value) &&
      !/\p{Cc}/u.test(value) &&
      value
        .replace(/\/$/, "")
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Đường dẫn phải tương đối trong repo, không chứa đoạn rỗng, dấu chấm hoặc hai dấu chấm.",
  );
export const DOC_DEFAULT_INCLUDE = ["docs/**", "doc/**", "specs/**", "adr/**", "**/adr/**", "**/README.md", "*.md"];
export const DOC_DEFAULT_EXCLUDE = [
  "node_modules/**",
  "vendor/**",
  ".git/**",
  ".github/**",
  ".claude/**",
  ".hive/**",
  "**/CHANGELOG.md",
  "**/LICENSE*",
];
export const projectDocsSettings = z.object({
  enabled: z.boolean().default(false),
  root: docRepoPath.default("docs/"),
  repoSync: z.enum(["pr", "direct", "off"]).default("pr"),
  include: z
    .array(pathGlob)
    .max(100)
    .default(() => [...DOC_DEFAULT_INCLUDE]),
  exclude: z
    .array(pathGlob)
    .max(100)
    .default(() => [...DOC_DEFAULT_EXCLUDE]),
  assetsDir: docRepoPath.default("assets"),
  repoChangesNeedReview: z.boolean().default(false),
});
export type ProjectDocsSettings = z.output<typeof projectDocsSettings>;

export const projectSettings = z.object({
  /** `full` bỏ kiểm soát của CLI; chỉ nên dùng trong container của M6. */
  runPermissions: z.object({ mode: runPermissionMode }).optional(),
  /** Model được dùng theo CLI và loại run; bỏ trống thì CLI chọn mặc định. */
  models: z
    .object({
      claude: z
        .object({
          code: z.string().trim().min(1).max(200).optional(),
          review: z.string().trim().min(1).max(200).optional(),
          leader: z.string().trim().min(1).max(200).optional(),
          plan: z.string().trim().min(1).max(200).optional(),
        })
        .optional(),
      codex: z
        .object({
          code: z.string().trim().min(1).max(200).optional(),
          review: z.string().trim().min(1).max(200).optional(),
          leader: z.string().trim().min(1).max(200).optional(),
          plan: z.string().trim().min(1).max(200).optional(),
        })
        .optional(),
      gemini: z
        .object({
          code: z.string().trim().min(1).max(200).optional(),
          review: z.string().trim().min(1).max(200).optional(),
          leader: z.string().trim().min(1).max(200).optional(),
          plan: z.string().trim().min(1).max(200).optional(),
        })
        .optional(),
      antigravity: z
        .object({
          code: z.string().trim().min(1).max(200).optional(),
          review: z.string().trim().min(1).max(200).optional(),
          leader: z.string().trim().min(1).max(200).optional(),
          plan: z.string().trim().min(1).max(200).optional(),
        })
        .optional(),
    })
    .optional(),
  merge: z.object({
    /** `review`: cần người duyệt. `auto`: tự merge khi đạt chính sách kết quả và CI. */
    mode: z.enum(["review", "auto"]),
    requiredApprovals: z.number().int().min(0).max(6),
    /** Cách merge của merge queue. GitLab chỉ phân biệt squash; rebase theo cấu hình của project GitLab. */
    method: mergeMethod.optional(),
    /** Bắt buộc có CI báo xanh mới merge; tắt thì repo không có CI vẫn merge được. */
    requireCi: z.boolean().optional(),
  }),
  outcome: z.object({
    default: z.array(outcomeCheck).max(20),
    byType: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), z.array(outcomeCheck).max(20)),
  }),
  /** Mọi tính năng bật/tắt theo dự án (docs/decisions.md, mục MVP). Tính năng chưa có thì mặc định tắt. */
  features: z.object({
    planMode: z.boolean(),
    crossReview: z.boolean(),
    mergeQueue: z.boolean(),
    leaderChat: z.boolean(),
    sandbox: z.boolean(),
    prCommentSync: z.boolean().default(true),
  }),
  /**
   * Giao việc từ issue GitHub/GitLab: issue gắn `label` thành task, bình luận nhắc `@mention` gửi tới bot. Có mặc
   * định vì dự án tạo trước khi có mục này không có nó trong settings đã lưu.
   */
  issueIntake: issueIntakeSettings.default(() => ({ ...defaultIssueIntake })),
  /** Có mặc định vì dự án tạo trước khi có mục này không có nó trong settings đã lưu. */
  tokenSaving: storedTokenSaving.default(() => ({ ...defaultTokenSaving })),
  /** Có mặc định vì settings đã lưu trước khi có định tuyến không có mục này. */
  routing: routingSettings.default(() => structuredClone(defaultRouting)),
  /**
   * CLI cho run không do người chọn (task từ issue, chạy lại theo bình luận). Bỏ trống thì máy nào có CLI cũng nhận.
   * Không đặt mặc định để settings đã lưu trước đó vẫn hợp lệ.
   */
  defaultCli: cli.nullable().optional(),
  /** Trần chi phí; không có là không giới hạn (docs/decisions.md: mặc định chỉ theo dõi chi phí). */
  budget: projectBudget.optional(),
  /** AI SDLC (specs/011); không có là chưa bật, dự án giữ nguyên hành vi cũ (FR-049). */
  sdlc: projectSdlcSettings.optional(),
  docs: projectDocsSettings.prefault({}),
  /** Có mặc định vì settings đã lưu trước ADR 0022 không có mục này. */
  brief: briefSettings.default(() => ({ ...DEFAULT_BRIEF_SETTINGS })),
});
export type ProjectSettings = z.output<typeof projectSettings>;

// Bản vá dùng strictObject ở mọi tầng: zod mặc định lặng lẽ bỏ khoá lạ, người gõ sai tên (`mergeQueu`) sẽ tưởng đã
// đổi được. Kết quả sau khi vá vẫn được hub kiểm lại bằng projectSettings.
const outcomeChecksPatch = z
  .array(
    z.discriminatedUnion("check", [
      outcomeCheck.options[0].strict(),
      outcomeCheck.options[1].strict(),
      outcomeCheck.options[2].strict(),
      outcomeCheck.options[3].strict(),
      outcomeCheck.options[4].strict(),
    ]),
  )
  .max(20);
const { merge, features } = projectSettings.shape;
const budgetShape = projectBudget.shape;
const modelName = z.string().trim().min(1).max(200);
const cliModelsPatch = z.strictObject({
  code: modelName.nullable().optional(),
  review: modelName.nullable().optional(),
});

/**
 * Đổi một phần settings. Trường bỏ trống giữ nguyên; `null` ở trường không bắt buộc là bỏ cấu hình đó (về mặc định
 * hoặc không giới hạn). Mảng chính sách kết quả thay cả mảng, vì thứ tự các bước có nghĩa.
 */
export const projectSettingsPatch = z
  .strictObject({
    merge: z
      .strictObject({
        mode: merge.shape.mode.optional(),
        requiredApprovals: merge.shape.requiredApprovals.optional(),
        method: mergeMethod.nullable().optional(),
        requireCi: z.boolean().nullable().optional(),
      })
      .optional(),
    outcome: z
      .strictObject({
        default: outcomeChecksPatch.optional(),
        byType: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), outcomeChecksPatch.nullable()).optional(),
      })
      .optional(),
    features: features.partial().extend({ prCommentSync: z.boolean().optional() }).strict().optional(),
    /** Đổi quyền CLI của run; `null` về mặc định (workspace). */
    runPermissions: z.strictObject({ mode: runPermissionMode }).nullable().optional(),
    /** Vá model theo từng CLI và loại run; `null` ở một ô là để CLI tự chọn. */
    models: z
      .strictObject({
        claude: cliModelsPatch.optional(),
        codex: cliModelsPatch.optional(),
        gemini: cliModelsPatch.optional(),
        antigravity: cliModelsPatch.optional(),
      })
      .optional(),
    issueIntake: issueIntakeSettings.partial().strict().optional(),
    tokenSaving: tokenSavingPatch.optional(),
    routing: z
      .strictObject({
        enabled: z.boolean().optional(),
        tiers: z
          .strictObject({
            light: tierRoute.partial().strict().optional(),
            medium: tierRoute.partial().strict().optional(),
            heavy: tierRoute.partial().strict().optional(),
          })
          .optional(),
      })
      .optional(),
    defaultCli: cli.nullable().optional(),
    budget: z
      .strictObject({
        perRunUsd: budgetShape.perRunUsd.unwrap().nullable().optional(),
        perTaskUsd: budgetShape.perTaskUsd.unwrap().nullable().optional(),
        maxTurns: budgetShape.maxTurns.unwrap().nullable().optional(),
        perRunTokens: budgetShape.perRunTokens.unwrap().nullable().optional(),
      })
      .nullable()
      .optional(),
    /** Thay cả mục AI SDLC (mục có nhiều danh sách lồng nhau, vá từng trường dễ sai hơn gửi lại cả mục). */
    sdlc: projectSdlcSettings.strict().optional(),
    docs: z
      .strictObject({
        enabled: projectDocsSettings.shape.enabled.unwrap().optional(),
        root: projectDocsSettings.shape.root.unwrap().optional(),
        repoSync: projectDocsSettings.shape.repoSync.unwrap().optional(),
        include: projectDocsSettings.shape.include.unwrap().optional(),
        exclude: projectDocsSettings.shape.exclude.unwrap().optional(),
        assetsDir: projectDocsSettings.shape.assetsDir.unwrap().optional(),
        repoChangesNeedReview: projectDocsSettings.shape.repoChangesNeedReview.unwrap().optional(),
      })
      .optional(),
    brief: briefSettings.partial().strict().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "Bản vá settings không có trường nào để đổi.");
export type ProjectSettingsPatch = z.output<typeof projectSettingsPatch>;

/**
 * Mặc định khi dự án chưa khai báo: task code kiểm `changes` (chưa biết lệnh test của repo nên chưa có `command`),
 * task nghiên cứu và tài liệu dựa vào báo cáo của agent.
 */
export function defaultProjectSettings(requiredApprovals = 1): ProjectSettings {
  return {
    merge: { mode: "review", requiredApprovals },
    outcome: {
      default: [{ check: "changes", required: true }],
      byType: {
        research: [{ check: "agentReport", required: true }],
        docs: [
          { check: "changes", required: true },
          { check: "agentReport", required: false },
        ],
      },
    },
    features: {
      planMode: false,
      crossReview: false,
      mergeQueue: false,
      leaderChat: false,
      sandbox: false,
      prCommentSync: true,
    },
    issueIntake: { ...defaultIssueIntake },
    tokenSaving: { ...defaultTokenSaving },
    routing: structuredClone(defaultRouting),
    docs: projectDocsSettings.parse({}),
    brief: { ...DEFAULT_BRIEF_SETTINGS },
  };
}

export const provisionStepKind = z.enum([
  "check-access",
  "create-repo",
  "link-repo",
  "commit-template",
  "protect-branch",
  "add-webhook",
]);
export type ProvisionStepKind = z.output<typeof provisionStepKind>;
export const provisionStepState = z.enum(["pending", "running", "done", "failed", "skipped"]);
export const projectState = z.enum(["provisioning", "active", "failed", "archived"]);
export type ProjectState = z.output<typeof projectState>;

export const stepError = z.object({
  code: z.string(),
  message: z.string(),
  /** Cách sửa, viết cho người quản trị; null khi chỉ cần thử lại. */
  fix: z.string().nullable(),
});

export const plannedStep = z.object({
  kind: provisionStepKind,
  target: z.string().nullable(),
  title: z.string(),
});

export const provisionStep = plannedStep.extend({
  id,
  position: z.number().int(),
  state: provisionStepState,
  error: stepError.nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  attempts: z.number().int(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ProvisionStep = z.output<typeof provisionStep>;

export const project = z.object({
  id,
  systemId: id,
  teamId: id,
  key: z.string(),
  name: z.string(),
  state: projectState,
  repo: z.object({
    mode: z.enum(["new", "existing"]),
    connectionId: id,
    kind: scmKind,
    owner: z.string(),
    name: z.string(),
    defaultBranch: z.string().nullable(),
    visibility: repoVisibility.nullable(),
    httpUrl: z.string().nullable(),
    sshUrl: z.string().nullable(),
    webUrl: z.string().nullable(),
  }),
  settings: projectSettings,
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.output<typeof project>;

export const warning = z.object({ code: z.string(), message: z.string() });

export const projectCreateResult = z.object({
  dryRun: z.boolean(),
  /** null khi dryRun. */
  projectId: id.nullable(),
  state: z.enum(["planned", ...projectState.options]),
  steps: z.array(plannedStep),
  warnings: z.array(warning),
});
export type ProjectCreateResult = z.output<typeof projectCreateResult>;

export const provisionView = z.object({ project, steps: z.array(provisionStep) });
export type ProvisionView = z.output<typeof provisionView>;

// ---- Merge queue ---------------------------------------------------------------------------------------------

/**
 * queued: chờ tới lượt. updating: đã yêu cầu cập nhật nhánh PR theo nhánh chính. waiting: chờ CI, người duyệt hoặc nhà
 * cung cấp tính xong. merging: đang merge. merged, failed, removed: đã xong.
 */
export const mergeQueueState = z.enum(["queued", "updating", "waiting", "merging", "merged", "failed", "removed"]);
export type MergeQueueState = z.output<typeof mergeQueueState>;

export const mergeQueueCiState = z.enum(["success", "pending", "failure", "none"]);
export type MergeQueueCiState = z.output<typeof mergeQueueCiState>;

export const mergeQueueEntry = z.object({
  id,
  projectId: id,
  prNumber: z.number().int().positive(),
  prUrl: z.string().nullable(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  /** Kết quả CI gần nhất hàng merge đã kiểm tra trên headSha; null khi chưa kiểm tra. */
  ciState: mergeQueueCiState.nullable(),
  runId: id.nullable(),
  taskId: id.nullable(),
  state: mergeQueueState,
  /** Đang chờ gì, hoặc vì sao không merge được. */
  note: z.string().nullable(),
  /** Vị trí trong hàng (1 là đang xử lý); null khi đã xong. */
  position: z.number().int().positive().nullable(),
  mergeSha: z.string().nullable(),
  enqueuedBy: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type MergeQueueEntry = z.output<typeof mergeQueueEntry>;

export const projectsContract = {
  create: orgRoute(
    "POST",
    "/v1/projects",
    "Tạo dự án, hoặc chạy thử với dryRun (quản trị đội của hệ thống)",
    "projects",
  )
    .input(projectCreateInput)
    .output(projectCreateResult),
  list: orgRoute("GET", "/v1/projects", "Dự án mình thấy được, lọc theo hệ thống", "projects")
    .input(z.object({ systemId: id.optional() }))
    .output(z.array(project)),
  get: orgRoute("GET", "/v1/projects/{id}", "Thông tin dự án", "projects").input(z.object({ id })).output(project),
  provision: orgRoute("GET", "/v1/projects/{id}/provision", "Các bước khởi tạo dự án và trạng thái", "projects")
    .input(z.object({ id }))
    .output(provisionView),
  retryStep: orgRoute(
    "POST",
    "/v1/projects/{id}/provision/{stepId}/retry",
    "Chạy lại bước khởi tạo bị lỗi (quản trị đội)",
    "projects",
  )
    .input(z.object({ id, stepId: id }))
    .output(provisionView),
  mergeQueue: orgRoute(
    "GET",
    "/v1/projects/{id}/merge-queue",
    "Hàng merge của dự án: mục đang chờ theo thứ tự, rồi 20 mục đã xong gần nhất",
    "projects",
  )
    .input(z.object({ id }))
    .output(z.array(mergeQueueEntry)),
  enqueueMerge: orgRoute(
    "POST",
    "/v1/projects/{id}/merge-queue",
    "Đưa PR vào hàng merge (thành viên đội). Người duyệt vẫn do bảo vệ nhánh trên GitHub/GitLab quyết",
    "projects",
  )
    .input(z.object({ id, prNumber: z.number().int().positive() }))
    .output(mergeQueueEntry),
  removeMerge: orgRoute(
    "DELETE",
    "/v1/projects/{id}/merge-queue/{entryId}",
    "Bỏ PR khỏi hàng merge (thành viên đội); mục đang merge thì không bỏ được",
    "projects",
  )
    .input(z.object({ id, entryId: id }))
    .output(mergeQueueEntry),
  updateSettings: orgRoute(
    "PATCH",
    "/v1/projects/{key}/settings",
    "Đổi một phần settings của dự án, trả settings sau khi đổi (quản trị đội sở hữu hoặc quản trị tổ chức)",
    "projects",
  )
    .input(z.object({ key: projectKey, settings: projectSettingsPatch }))
    .output(projectSettings),
};
