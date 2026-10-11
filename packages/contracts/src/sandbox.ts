import { oc } from "@orpc/contract";
import { z } from "zod";
import { egressRule } from "./egress.ts";

const id = z.uuid("Mã không hợp lệ.");
const reason = z.object({ code: z.string() }).optional();
const base = oc.errors({
  UNAUTHORIZED: { message: "Chưa đăng nhập." },
  BAD_REQUEST: { message: "Dữ liệu không hợp lệ.", data: reason },
  FORBIDDEN: { message: "Bạn không có quyền làm việc này.", data: reason },
  NOT_FOUND: { message: "Không tìm thấy.", data: reason },
  CONFLICT: { message: "Cấu hình hiện tại không cho phép thao tác.", data: reason },
});
const scope = z.object({ projectId: id.optional() });
export const allowlistEntry = z.object({
  id,
  projectId: id.nullable(),
  rule: egressRule,
  note: z.string().nullable(),
  addedBy: z.string(),
  createdAt: z.iso.datetime(),
});
export type AllowlistEntry = z.output<typeof allowlistEntry>;
export const sandboxOrgSettings = z.object({ locked: z.boolean(), useSuggestedDefaults: z.boolean() });
export type SandboxOrgSettings = z.output<typeof sandboxOrgSettings>;
export const effectiveAllowlist = z.object({
  ...sandboxOrgSettings.shape,
  rules: z.array(egressRule),
  suggestedRules: z.array(egressRule),
});
export type EffectiveAllowlist = z.output<typeof effectiveAllowlist>;
export const envImageInput = z.object({
  baseImage: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/, "Tên image không hợp lệ."),
  setupScriptHash: z.string().regex(/^[a-f0-9]{64}$/, "Hash script phải là SHA-256 viết thường."),
});
export const envImage = envImageInput.extend({ projectId: id, updatedAt: z.iso.datetime() });
export type EnvImage = z.output<typeof envImage>;

/** Snapshot bất biến của mỗi job, runner host không tự hợp nhất allowlist. */
export const sandboxJobConfig = z.object({
  allowlist: z.array(egressRule),
  image: envImageInput,
});
export type SandboxJobConfig = z.output<typeof sandboxJobConfig>;
const route = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, summary: string) =>
  base.route({ method, path: `/v1/sandbox${path}`, summary, tags: ["sandbox"] });
export const sandboxContract = {
  listAllowlist: route("GET", "/allowlist", "Xem mục mạng của tổ chức hoặc dự án")
    .input(scope)
    .output(z.array(allowlistEntry)),
  addAllowlist: route("POST", "/allowlist", "Thêm mục mạng")
    .input(scope.extend({ rule: egressRule, note: z.string().max(2000).optional() }))
    .output(allowlistEntry),
  removeAllowlist: route("DELETE", "/allowlist/{entryId}", "Xoá mục mạng")
    .input(scope.extend({ entryId: id }))
    .output(z.object({ removed: z.literal(true) })),
  getOrgSettings: route("GET", "/settings", "Xem khoá allowlist tổ chức").output(sandboxOrgSettings),
  updateOrgSettings: route("PUT", "/settings", "Khoá allowlist hoặc bật danh sách đề xuất")
    .input(sandboxOrgSettings)
    .output(sandboxOrgSettings),
  effectiveAllowlist: route("GET", "/projects/{projectId}/allowlist", "Xem allowlist hiệu lực")
    .input(z.object({ projectId: id }))
    .output(effectiveAllowlist),
  getImage: route("GET", "/projects/{projectId}/image", "Xem image môi trường")
    .input(z.object({ projectId: id }))
    .output(envImage.nullable()),
  setImage: route("PUT", "/projects/{projectId}/image", "Đặt image môi trường")
    .input(envImageInput.extend({ projectId: id }))
    .output(envImage),
};
