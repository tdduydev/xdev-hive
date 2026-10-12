import { z } from "zod";
import { orgRoute } from "./common.ts";

/**
 * Kho skill Git của tổ chức (specs/006-skills-repo-sync, ADR 0014): Git là bản gốc, hub giữ bản đọc nhanh. Thư mục
 * `org/<skill>/`, `teams/<slug đội>/<skill>/`, `projects/<key dự án>/<skill>/`, mỗi skill một `SKILL.md`.
 */
export const skillRepoStatus = z.enum(["idle", "syncing", "ok", "failed"]);

export const skillRepo = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  owner: z.string(),
  name: z.string(),
  branch: z.string(),
  status: skillRepoStatus,
  lastSha: z.string().nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
  /** Lỗi lần đồng bộ gần nhất, hoặc cảnh báo (thư mục không khớp đội/dự án nào). */
  error: z.string().nullable(),
  /** Địa chỉ webhook đã gắn vào repo; null khi nhà cung cấp không nhận (hub không công khai): chỉ đồng bộ tay. */
  webhookUrl: z.string().nullable(),
  /** Số skill mới chỉ có trên hub, chưa vào Git. */
  hubOnly: z.number().int(),
});
export type SkillRepo = z.output<typeof skillRepo>;

const repoPart = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/, "Chỉ dùng chữ, số, dấu chấm, gạch ngang, gạch dưới và /.");

export const skillRepoInput = z.object({
  connectionId: z.uuid(),
  owner: repoPart,
  name: repoPart,
  branch: z.string().trim().min(1).max(200).default("main"),
});

export const skillRepoContract = {
  get: orgRoute("GET", "/v1/skills/repo", "Kho skill Git của tổ chức", "skills").output(skillRepo.nullable()),
  set: orgRoute("POST", "/v1/skills/repo", "Kết nối kho skill Git (quản trị tổ chức)", "skills")
    .input(skillRepoInput)
    .output(skillRepo),
  remove: orgRoute("DELETE", "/v1/skills/repo", "Gỡ kho skill Git (skill trên hub giữ nguyên)", "skills").output(
    z.object({ ok: z.literal(true) }),
  ),
  sync: orgRoute("POST", "/v1/skills/repo/sync", "Đồng bộ ngay từ Git và đẩy skill chỉ có trên hub", "skills").output(
    z.object({ queued: z.boolean() }),
  ),
};
