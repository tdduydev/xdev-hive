import {
  type ProjectState,
  type ProvisionStep,
  type ScmConnection,
  type ScmConnectionCreateInput,
  scmConnectionCreateInput,
} from "@xdev-hive/contracts";
import type { Dict, Lang } from "@/lib/i18n.ts";
import type { Tone } from "@/lib/run-view.ts";

/** Đường dẫn màn Kết nối Git; thẻ "Bắt đầu" và dialog tạo dự án dẫn tới đây. */
export const GIT_CONNECTIONS_PATH = "/admin/git";

/** Chữ người quản trị gõ vào form thêm kết nối, giữ nguyên dạng chuỗi như trong ô nhập. */
export interface ConnectionDraft {
  kind: "github" | "gitlab";
  authMode: "token" | "app";
  name: string;
  baseUrl: string;
  defaultOwner: string;
  token: string;
  appId: string;
  installationId: string;
  privateKey: string;
}

export type ConnectionField = Exclude<keyof ConnectionDraft, "kind" | "authMode">;
export type ConnectionErrors = Partial<Record<ConnectionField, string>>;

const FIELDS: readonly ConnectionField[] = [
  "name",
  "baseUrl",
  "defaultOwner",
  "token",
  "appId",
  "installationId",
  "privateKey",
];
const isField = (v: unknown): v is ConnectionField => (FIELDS as readonly unknown[]).includes(v);

/** Ô bỏ trống thì không gửi, để zod dùng giá trị mặc định (github.com, gitlab.com) thay vì báo URL sai. */
function draftToInput(d: ConnectionDraft): Record<string, unknown> {
  const base = {
    kind: d.kind,
    name: d.name,
    ...(d.baseUrl.trim() ? { baseUrl: d.baseUrl.trim() } : {}),
    ...(d.defaultOwner.trim() ? { defaultOwner: d.defaultOwner.trim() } : {}),
  };
  if (d.kind === "gitlab") return { ...base, token: d.token };
  if (d.authMode === "token") return { ...base, authMode: "token", token: d.token };
  const installation = d.installationId.trim();
  return {
    ...base,
    authMode: "app",
    appId: d.appId.trim(),
    privateKey: d.privateKey.trim(),
    installationId: /^\d+$/.test(installation) ? Number(installation) : Number.NaN,
  };
}

/**
 * Lỗi zod gắn vào ô. Lỗi thiếu ô hay sai kiểu là thông báo tiếng Anh của zod nên viết lại; còn lại dùng câu hợp đồng đã
 * viết sẵn.
 */
export function issuesToConnectionErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string; code?: string }[],
): ConnectionErrors {
  const out: ConnectionErrors = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (!isField(field)) continue;
    let message = issue.message;
    if (field === "installationId") message = "Installation ID là số nguyên dương.";
    else if (issue.code === "invalid_type") message = "Không được để trống.";
    out[field] ??= message;
  }
  return out;
}

/** Kiểm form theo hợp đồng trước khi gửi. Trả input đã chuẩn hoá (bỏ `/` cuối URL…) hoặc lỗi theo ô. */
export function parseConnectionDraft(
  d: ConnectionDraft,
): { ok: true; input: ScmConnectionCreateInput } | { ok: false; errors: ConnectionErrors } {
  const parsed = scmConnectionCreateInput.safeParse(draftToInput(d));
  if (parsed.success) return { ok: true, input: parsed.data };
  const errors = issuesToConnectionErrors(parsed.error.issues);
  // Lỗi không gắn được vào ô nào vẫn phải chặn gửi; đặt vào ô tên để người dùng thấy.
  if (Object.keys(errors).length === 0) errors.name = parsed.error.issues[0]?.message ?? "Dữ liệu chưa hợp lệ.";
  return { ok: false, errors };
}

/** Máy chủ của kết nối: github.com khi không có baseUrl, còn lại là host trong URL. */
export function connectionHost(c: Pick<ScmConnection, "kind" | "baseUrl">): string {
  if (!c.baseUrl) return c.kind === "github" ? "github.com" : "gitlab.com";
  try {
    return new URL(c.baseUrl).host;
  } catch {
    return c.baseUrl;
  }
}

/** Cách xác thực, kèm App ID và installation (không bí mật) để người quản trị nhận ra kết nối. */
export function connectionAuthLabel(c: Pick<ScmConnection, "authMode" | "appId" | "installationId">): string {
  if (c.authMode === "token") return "Access token";
  const parts = [`GitHub App${c.appId ? ` #${c.appId}` : ""}`];
  if (c.installationId) parts.push(`installation ${c.installationId}`);
  return parts.join(", ");
}

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
