import { z } from "zod";
import { id, orgRoute } from "./common.ts";
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

export const projectSettings = z.object({
  /** Model được dùng theo CLI và loại run; bỏ trống thì CLI chọn mặc định. */
  models: z
    .object({
      claude: z
        .object({
          code: z.string().trim().min(1).max(200).optional(),
          review: z.string().trim().min(1).max(200).optional(),
        })
        .optional(),
      codex: z
        .object({
          code: z.string().trim().min(1).max(200).optional(),
          review: z.string().trim().min(1).max(200).optional(),
        })
        .optional(),
      gemini: z
        .object({
          code: z.string().trim().min(1).max(200).optional(),
          review: z.string().trim().min(1).max(200).optional(),
        })
        .optional(),
    })
    .optional(),
  merge: z.object({
    /** `review`: cần người duyệt. `auto`: tự merge khi đạt chính sách kết quả và CI. */
    mode: z.enum(["review", "auto"]),
    requiredApprovals: z.number().int().min(0).max(6),
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
  }),
  /**
   * Giao việc từ issue GitHub/GitLab: issue gắn `label` thành task, bình luận nhắc `@mention` gửi tới bot. Có mặc
   * định vì dự án tạo trước khi có mục này không có nó trong settings đã lưu.
   */
  issueIntake: issueIntakeSettings.default(() => ({ ...defaultIssueIntake })),
  /**
   * CLI cho run không do người chọn (task từ issue, chạy lại theo bình luận). Bỏ trống thì máy nào có CLI cũng nhận.
   * Không đặt mặc định để settings đã lưu trước đó vẫn hợp lệ.
   */
  defaultCli: cli.nullable().optional(),
});
export type ProjectSettings = z.output<typeof projectSettings>;

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
    features: { planMode: false, crossReview: false, mergeQueue: false, leaderChat: false, sandbox: false },
    issueIntake: { ...defaultIssueIntake },
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
};
