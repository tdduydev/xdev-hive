import { z } from "zod";
import { id, orgRoute } from "./common.ts";

export const scmKind = z.enum(["github", "gitlab"]);
export type ScmKind = z.output<typeof scmKind>;

/** GitHub: org. GitLab: đường dẫn group hoặc user, có thể lồng (`a/b`). */
export const repoOwner = z
  .string()
  .regex(/^[A-Za-z0-9][\w.-]{0,99}(\/[\w.-]+)*$/, "Owner chỉ gồm chữ, số, `.`, `_`, `-` và `/` giữa các group.");

const name = z.string().trim().min(1, "Tên không được để trống.").max(80, "Tên dài tối đa 80 ký tự.");
const httpsUrl = z
  .url("URL không hợp lệ.")
  .refine((u) => u.startsWith("https://"), "Chỉ nhận địa chỉ https.")
  .transform((u) => u.replace(/\/+$/, ""));

export const scmConnectionCreateInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github"),
    name,
    /** Bỏ trống với github.com. GitHub Enterprise Server: `https://ghe.example.com/api/v3`. */
    baseUrl: httpsUrl.optional(),
    defaultOwner: repoOwner,
    appId: z.string().regex(/^\d{1,12}$/, "App ID là số."),
    privateKey: z
      .string()
      .max(20_000)
      .refine((k) => k.includes("PRIVATE KEY-----"), "Khoá riêng phải ở dạng PEM của GitHub App."),
    installationId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("gitlab"),
    name,
    baseUrl: httpsUrl.default("https://gitlab.com"),
    defaultOwner: repoOwner.optional(),
    /** Personal, group hoặc project access token có scope `api`. */
    token: z.string().trim().min(8, "Token quá ngắn.").max(500),
  }),
]);
export type ScmConnectionCreateInput = z.input<typeof scmConnectionCreateInput>;

/** Không bao giờ chứa secret; chỉ mô tả để chọn kết nối khi tạo dự án. */
export const scmConnection = z.object({
  id,
  kind: scmKind,
  name: z.string(),
  baseUrl: z.string().nullable(),
  defaultOwner: z.string().nullable(),
  /** GitHub App id, installation id: không bí mật, giúp người quản trị nhận ra kết nối. */
  appId: z.string().nullable(),
  installationId: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
});
export type ScmConnection = z.output<typeof scmConnection>;

export const scmConnectionTestResult = z.object({
  ok: z.boolean(),
  owner: z.string().nullable(),
  canCreate: z.boolean(),
  missingScopes: z.array(z.string()),
  message: z.string(),
});
export type ScmConnectionTestResult = z.output<typeof scmConnectionTestResult>;

export const scmContract = {
  list: orgRoute("GET", "/v1/scm-connections", "Kết nối Git của tổ chức", "scm").output(z.array(scmConnection)),
  create: orgRoute("POST", "/v1/scm-connections", "Thêm kết nối Git (quản trị tổ chức)", "scm")
    .input(scmConnectionCreateInput)
    .output(scmConnection),
  test: orgRoute("POST", "/v1/scm-connections/{id}/test", "Kiểm quyền của kết nối Git (quản trị tổ chức)", "scm")
    .input(z.object({ id, owner: repoOwner.optional() }))
    .output(scmConnectionTestResult),
  remove: orgRoute(
    "DELETE",
    "/v1/scm-connections/{id}",
    "Xoá kết nối Git chưa dự án nào dùng (quản trị tổ chức)",
    "scm",
  )
    .input(z.object({ id }))
    .output(z.object({ id })),
};
