import { oc } from "@orpc/contract";
import { z } from "zod";
import { auditContract } from "./audit.ts";
import { codeReviewsContract } from "./code-reviews.ts";
import { costsContract } from "./cost.ts";
import { desktopConnectContract } from "./desktop-connect.ts";
import { docEditorContract } from "./doc-editor.ts";
import { fleetContract } from "./fleet.ts";
import { briefContract, docsContract, memoryContract, proposalsContract, skillsContract } from "./knowledge.ts";
import { leaderContract } from "./leader.ts";
import { mcpAdminContract } from "./mcp-admin.ts";
import { inboxContract, notificationChannelsContract } from "./notify.ts";
import { policiesContract } from "./policies.ts";
import { projectsContract } from "./projects.ts";
import { rolesContract } from "./roles.ts";
import { runsContract } from "./runs.ts";
import { sandboxContract } from "./sandbox.ts";
import { scmContract } from "./scm.ts";
import { sdlcContract } from "./sdlc.ts";
import { skillRepoContract } from "./skills-sync.ts";
import { tasksContract } from "./tasks.ts";
import { tenancyContract } from "./tenancy.ts";
import { terminalContract } from "./terminal.ts";
import { reviewsContract, workflowsContract } from "./workflows.ts";

export * from "./audit.ts";
export * from "./breakdown.ts";
export * from "./code-reviews.ts";
export * from "./cost.ts";
export * from "./desktop-connect.ts";
export * from "./doc-editor.ts";
export * from "./doc-text.ts";
export * from "./egress.ts";
export * from "./glob.ts";
export * from "./knowledge.ts";
export * from "./knowledge-search.ts";
export * from "./line-diff.ts";
export * from "./mcp-admin.ts";
export * from "./notify.ts";
export * from "./policies.ts";
export * from "./projects.ts";
export * from "./repo-url.ts";
export * from "./roles.ts";
export * from "./run-log.ts";
export * from "./runs.ts";
export * from "./sandbox.ts";
export * from "./scm.ts";
export * from "./sdlc.ts";
export * from "./sdlc-presets/index.ts";
export * from "./skills-sync.ts";
export * from "./tasks.ts";
export * from "./tenancy.ts";
export * from "./terminal.ts";
export * from "./version.ts";
export * from "./workflows.ts";

// Lỗi kiểm tra đầu vào được trả thẳng cho người dùng (hub) và hiện trên form (web), nên dùng tiếng Việt cho mọi
// thông báo mặc định của zod. Schema nào cần câu rõ hơn thì tự ghi message riêng.
z.config(z.locales.vi());

/** Trạng thái hub. Worker Go gọi qua OpenAPI (GET /api/v1/health) trước khi mở WSS. */
export const healthOutput = z.object({
  status: z.literal("ok"),
  version: z.string(),
  time: z.iso.datetime(),
  /** Giờ dựng image của hub và web (cùng một image); null khi chạy từ mã nguồn. Hub cũ không trả. */
  builtAt: z.iso.datetime().nullable().optional(),
  /** CLI hub giao run được; worker chỉ khai những CLI này trong hello và khi đăng ký. Hub cũ không trả. */
  clis: z.array(z.string()).optional(),
});
export const desktopUpdateOutput = z.object({
  version: z.string(),
  notes: z.string().nullable(),
  pub_date: z.string().nullable(),
  url: z.url(),
  signature: z.string(),
});
export type Health = z.output<typeof healthOutput>;

/** Người đang đăng nhập. */
export const meOutput = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  image: z.string().nullable(),
});
export type Me = z.output<typeof meOutput>;

export const contract = {
  system: {
    health: oc
      .route({ method: "GET", path: "/v1/health", summary: "Trạng thái hub", tags: ["system"] })
      .output(healthOutput),
    desktopUpdate: oc
      .route({
        method: "GET",
        path: "/v1/desktop/updates/{os}/{arch}/{currentVersion}",
        summary: "Kiểm tra cập nhật desktop",
        tags: ["system"],
      })
      .input(
        z.object({
          os: z.enum(["macos", "linux", "windows"]),
          arch: z.enum(["aarch64", "x86_64"]),
          currentVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
        }),
      )
      .output(desktopUpdateOutput.nullable()),
  },
  me: {
    get: oc
      .route({ method: "GET", path: "/v1/me", summary: "Người đang đăng nhập", tags: ["identity"] })
      .errors({ UNAUTHORIZED: { message: "Chưa đăng nhập." } })
      .output(meOutput),
  },
  ...fleetContract,
  ...tenancyContract,
  scmConnections: scmContract,
  notificationChannels: notificationChannelsContract,
  inbox: inboxContract,
  projects: projectsContract,
  memory: memoryContract,
  docs: docsContract,
  briefs: briefContract,
  skills: skillsContract,
  proposals: proposalsContract,
  tasks: tasksContract,
  runs: runsContract,
  audit: auditContract,
  costs: costsContract,
  sandbox: sandboxContract,
  leader: leaderContract,
  mcpAdmin: mcpAdminContract,
  roles: rolesContract,
  skillRepo: skillRepoContract,
  policies: policiesContract,
  reviewWorkflows: workflowsContract,
  reviews: reviewsContract,
  codeReviews: codeReviewsContract,
  docEditor: docEditorContract,
  desktopConnect: desktopConnectContract,
  sdlc: sdlcContract,
  terminal: terminalContract,
};

export type Contract = typeof contract;

export * from "./fleet.ts";
export * from "./leader.ts";
