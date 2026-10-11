import type { SsoJoin } from "@xdev-hive/contracts";

export const SSO_JOIN_LABEL: Record<SsoJoin, string> = {
  pending: "Vào hàng chờ duyệt (khuyên dùng)",
  member: "Tự thêm vào tổ chức với vai trò Thành viên, chưa thuộc đội nào",
};

export const SSO_JOINS: readonly SsoJoin[] = ["pending", "member"];

export interface SsoFormValues {
  issuer: string;
  domain: string;
  clientId: string;
  clientSecret: string;
}

export type SsoFormErrors = Partial<Record<keyof SsoFormValues, string>>;

// Cùng biểu thức với emailDomain trong packages/contracts, để báo ngay cạnh ô thay vì chờ hub.
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Lỗi nhập của form SSO, kiểm trên máy trước khi gửi. `configured`: tổ chức đã lưu SSO, khi đó bỏ trống secret
 * nghĩa là giữ secret cũ (hub không bao giờ trả secret về).
 */
export function checkSsoForm(values: SsoFormValues, configured: boolean): SsoFormErrors {
  const errors: SsoFormErrors = {};
  let issuer: URL | null = null;
  try {
    issuer = new URL(values.issuer.trim());
  } catch {
    issuer = null;
  }
  if (!issuer || (issuer.protocol !== "https:" && issuer.protocol !== "http:"))
    errors.issuer = "Nhập Issuer URL dạng https://…, lấy trong cấu hình app bên nhà cung cấp.";
  if (!DOMAIN.test(values.domain.trim().toLowerCase())) errors.domain = "Nhập tên miền email, ví dụ congty.vn.";
  if (!values.clientId.trim()) errors.clientId = "Nhập Client ID.";
  if (!configured && !values.clientSecret) errors.clientSecret = "Nhập Client secret khi cấu hình SSO lần đầu.";
  return errors;
}

/** Tên máy của issuer để hiện gọn trong danh sách cách đăng nhập. */
export function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}
