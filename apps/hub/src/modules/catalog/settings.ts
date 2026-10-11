import { type ProjectSettings, type ProjectSettingsPatch, projectSettings } from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { BadRequestError, NotFoundError, type Tx } from "../platform/index.ts";
import { requireTeamRole, teamRoleOf } from "../tenancy/index.ts";
import { findProject } from "./projects.ts";
import { projects } from "./schema.ts";

/** Gán từng khoá của bản vá; `null` là bỏ khoá để trường không bắt buộc về mặc định. */
function assign<T extends object>(base: T | undefined, patch: object): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

/** Áp bản vá lên settings hiện tại. Chưa kiểm kết quả; người gọi kiểm bằng projectSettings. */
export function applySettingsPatch(current: ProjectSettings, patch: ProjectSettingsPatch): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  if (patch.merge) next.merge = assign(current.merge, patch.merge);
  if (patch.outcome) {
    next.outcome = {
      default: patch.outcome.default ?? current.outcome.default,
      byType: patch.outcome.byType ? assign(current.outcome.byType, patch.outcome.byType) : current.outcome.byType,
    };
  }
  if (patch.features) next.features = assign(current.features, patch.features);
  if (patch.issueIntake) next.issueIntake = assign(current.issueIntake, patch.issueIntake);
  if (patch.defaultCli !== undefined) next.defaultCli = patch.defaultCli;
  if (patch.budget !== undefined) {
    const budget = patch.budget === null ? {} : assign(current.budget, patch.budget);
    // Budget rỗng và không có budget cùng nghĩa (không giới hạn); bỏ hẳn để settings đã lưu gọn như lúc tạo.
    if (Object.keys(budget).length > 0) next.budget = budget;
    else delete next.budget;
  }
  return next;
}

/**
 * Đổi một phần settings của dự án theo project key. Quyền như sửa dự án: quản trị đội sở hữu, hoặc owner/admin tổ
 * chức (teamRoleOf coi họ là quản trị mọi đội).
 *
 * Khoá dòng dự án (FOR UPDATE) rồi mới đọc, vá và ghi trong cùng transaction: hai người sửa hai trường khác nhau
 * cùng lúc thì người sau chờ người trước commit rồi vá lên bản mới, không ghi đè trường của nhau. Không làm bằng
 * jsonb merge trong SQL vì kết quả phải qua projectSettings (ví dụ `requiredApprovals` vẫn trong khoảng cho phép).
 */
export async function updateProjectSettings(
  tx: Tx,
  userId: string,
  key: string,
  patch: ProjectSettingsPatch,
): Promise<ProjectSettings> {
  const ref = await findProject(tx, key);
  // Không thấy dự án thì báo như không tồn tại, để không lộ key của đội khác.
  if (!ref || !(await teamRoleOf(tx, userId, ref.teamId))) {
    throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
  }
  await requireTeamRole(tx, userId, ref.teamId, "admin");
  const [row] = await tx
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, ref.id))
    .for("update");
  if (!row) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
  // Parse bản đang lưu để điền mặc định cho mục thêm sau (issueIntake) trước khi vá. Bản đang lưu hỏng (sửa tay bằng
  // SQL) thì vá trên bản thô, để quản trị sửa được chính trường hỏng qua API thay vì bị chặn mãi.
  const parsed = projectSettings.safeParse(row.settings);
  const current = parsed.success ? parsed.data : row.settings;
  const checked = projectSettings.safeParse(applySettingsPatch(current, patch));
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    throw new BadRequestError(
      "SETTINGS_INVALID",
      `Settings sau khi đổi không hợp lệ${path ? ` ở trường ${path}` : ""}: ${issue?.message ?? "không rõ lỗi"}`,
    );
  }
  const next = checked.data;
  await tx.update(projects).set({ settings: next, updatedAt: sql`now()` }).where(eq(projects.id, ref.id));
  // Chỉ ghi các mục được vá. Settings không chứa secret (secret của dự án nằm trong bảng secrets, mã hoá riêng), nên
  // ghi nguyên giá trị trước và sau.
  const touched = Object.keys(patch) as Array<keyof ProjectSettings>;
  const pick = (s: ProjectSettings) => Object.fromEntries(touched.map((k) => [k, s[k] ?? null]));
  await recordAudit(tx, {
    action: "project.settings.update",
    targetType: "project",
    targetId: ref.id,
    data: { key: ref.key, before: pick(current), after: pick(next) },
  });
  return next;
}
