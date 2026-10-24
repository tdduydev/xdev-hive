import {
  QA_ERRORS,
  QA_TC_DIR_DEFAULT,
  type QaErrorCode,
  qaErrorMessage,
  type TestIncludeResult,
} from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import { findProject, type ProjectRef } from "../catalog/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { checkTeamRole, effectivePermissions, teamRoleOf } from "../tenancy/index.ts";
import { qaProjectSettings } from "./schema.ts";

// Kiểm quyền chung của mọi route kiểm thử (contracts/hub-api.md, FR-015, FR-016).

export type QaPermission = "qa.read" | "qa.cases.write" | "qa.record" | "qa.rounds.manage" | "projects.settings";

export interface QaProjectSettings {
  enabled: boolean;
  tcDir: string;
  includeResult: TestIncludeResult | null;
}

export interface QaProject {
  project: ProjectRef;
  settings: QaProjectSettings;
  permissions: Set<string>;
}

export const projectNotFound = () => new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");

/** Lỗi theo `QA_ERRORS` để mã, trạng thái và thông điệp cùng một nguồn với hợp đồng. */
export function qaError(code: QaErrorCode, values?: Record<string, string | number>): Error {
  const message = qaErrorMessage(code, values);
  const status = QA_ERRORS[code].status;
  if (status === "FORBIDDEN") return new ForbiddenError(code, message);
  if (status === "CONFLICT") return new ConflictError(code, message);
  return new BadRequestError(code, message);
}

export async function loadQaProjectSettings(tx: Tx, projectId: string): Promise<QaProjectSettings> {
  const [row] = await tx
    .select({
      enabled: qaProjectSettings.enabled,
      tcDir: qaProjectSettings.tcDir,
      includeResult: qaProjectSettings.includeResult,
    })
    .from(qaProjectSettings)
    .where(eq(qaProjectSettings.projectId, projectId));
  // Chưa có dòng nghĩa là admin dự án chưa từng bật: coi như tắt, thư mục mặc định.
  if (!row) return { enabled: false, tcDir: QA_TC_DIR_DEFAULT, includeResult: null };
  return { ...row, includeResult: row.includeResult as TestIncludeResult | null };
}

/**
 * Dự án theo id hoặc key cùng cài đặt kiểm thử, sau khi kiểm người gọi có một trong các quyền `need` ở đội sở hữu.
 * Dự án ngoài đội báo như không tồn tại để không lộ dự án của đội khác (D22). Chỉ `projectSettings.*` đặt
 * `allowDisabled`, vì admin phải xem và bật được thư viện khi nó đang tắt.
 */
export async function qaProject(
  tx: Tx,
  userId: string,
  ref: string,
  need: QaPermission | readonly QaPermission[],
  opts: { allowDisabled?: boolean } = {},
): Promise<QaProject> {
  const project = await findProject(tx, ref);
  if (!project) throw projectNotFound();
  const role = await teamRoleOf(tx, userId, project.teamId);
  if (!role) throw projectNotFound();
  checkTeamRole(role, "viewer");
  const permissions = await effectivePermissions(tx, userId, project.teamId);
  const anyOf: readonly QaPermission[] = typeof need === "string" ? [need] : need;
  if (!anyOf.some((p) => permissions.has(p)))
    throw new ForbiddenError(
      "QA_PERMISSION_REQUIRED",
      `Cần quyền ${anyOf.map((p) => `\`${p}\``).join(" hoặc ")} ở đội của dự án này.`,
    );
  const settings = await loadQaProjectSettings(tx, project.id);
  if (!settings.enabled && !opts.allowDisabled) throw qaError("QA_LIBRARY_DISABLED");
  return { project, settings, permissions };
}
