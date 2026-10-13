import type { ProjectState, ProvisionStep } from "@xdev-hive/contracts";
import type { Dict, Lang } from "@/lib/i18n.ts";
import type { Tone } from "@/lib/run-view.ts";

export const PROVISION_STEP_STATE: Record<ProvisionStep["state"], { label: Dict<string>; tone: Tone }> = {
  pending: { label: { vi: "Chờ chạy", en: "Pending" }, tone: "neutral" },
  running: { label: { vi: "Đang chạy", en: "Running" }, tone: "sel" },
  done: { label: { vi: "Xong", en: "Done" }, tone: "ok" },
  failed: { label: { vi: "Lỗi", en: "Failed" }, tone: "bad" },
  skipped: { label: { vi: "Bỏ qua", en: "Skipped" }, tone: "neutral" },
};

/** Dự án chưa dùng được thì phải hiện các bước khởi tạo để người quản trị thấy bước nào kẹt. */
export const showsProvision = (state: ProjectState): boolean => state === "provisioning" || state === "failed";

/** Đang có bước chờ hoặc đang chạy thì hỏi lại hub định kỳ; hết bước chạy thì thôi. */
export const provisionInFlight = (steps: readonly Pick<ProvisionStep, "state">[]): boolean =>
  steps.some((s) => s.state === "pending" || s.state === "running");

const BLOCKED: Dict<Record<"provisioning" | "failed" | "archived" | "none", string>> = {
  vi: {
    provisioning: "Chưa tạo được việc: dự án đang khởi tạo.",
    failed: "Chưa tạo được việc: khởi tạo dự án bị lỗi. Chạy lại bước lỗi ở dưới.",
    archived: "Không tạo được việc: dự án đã lưu trữ.",
    none: "Chưa tạo được việc: chưa có dự án nào đang hoạt động.",
  },
  en: {
    provisioning: "Tasks are unavailable while the project is being set up.",
    failed: "Tasks are unavailable because project setup failed. Retry the failed step below.",
    archived: "Tasks are unavailable because the project is archived.",
    none: "Tasks are unavailable until a project is active.",
  },
};

/** Lý do nút "Tạo việc" bị khoá; null khi tạo được. `state` undefined là bảng việc chung (không lọc dự án). */
export function createTaskBlockedReason(
  state: ProjectState | undefined,
  activeCount: number,
  lang: Lang,
): string | null {
  if (activeCount > 0) return null;
  const t = BLOCKED[lang];
  if (state === undefined || state === "active") return t.none;
  return t[state];
}
