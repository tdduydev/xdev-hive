import type { InvitationStatus, OrgRole } from "@xdev-hive/contracts";
import { isOrgAdmin } from "./roles.ts";

/** Khớp giới hạn của invitations.create trong packages/contracts. */
export const MAX_INVITES = 50;

export interface ParsedEmails {
  /** Email hợp lệ, chữ thường, bỏ trùng, giữ thứ tự nhập. */
  emails: string[];
  /** Phần người dùng gõ mà không phải email, giữ nguyên để báo lại đúng chữ họ thấy. */
  invalid: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@.]+$/;

/**
 * Tách ô email của hộp thoại mời. Nhận cả dấu phẩy, chấm phẩy, khoảng trắng và xuống dòng vì người dùng hay dán
 * danh sách chép từ bảng tính hoặc thư. Hub vẫn kiểm lại từng email.
 */
export function parseEmails(text: string): ParsedEmails {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    if (!part) continue;
    if (!EMAIL.test(part)) invalid.push(part);
    else if (!emails.includes(part.toLowerCase())) emails.push(part.toLowerCase());
  }
  return { emails, invalid };
}

/** Lỗi nhập của ô email, hoặc undefined nếu gửi được. */
export function emailsError({ emails, invalid }: ParsedEmails): string | undefined {
  if (invalid.length > 0) return `Email không hợp lệ: ${invalid.join(", ")}.`;
  if (emails.length === 0) return "Nhập ít nhất một email.";
  if (emails.length > MAX_INVITES) return `Mời tối đa ${MAX_INVITES} email mỗi lần.`;
  return undefined;
}

/**
 * Vai trò tổ chức người này được mời. Hub chỉ cho chủ sở hữu mời quản trị (mời là cấp vai trò, như đổi vai trò),
 * và không mời ai làm chủ sở hữu. Thành viên thường không mời được ai.
 */
export function invitableRoles(actor: OrgRole): ("admin" | "member")[] {
  if (actor === "owner") return ["member", "admin"];
  return isOrgAdmin(actor) ? ["member"] : [];
}

export const canInvite = (actor: OrgRole): boolean => invitableRoles(actor).length > 0;

export const INVITATION_STATUS_LABEL: Record<InvitationStatus, string> = {
  pending: "Chờ nhận",
  accepted: "Đã nhận",
  expired: "Hết hạn",
};

/** Lời mời còn thu hồi được: hub từ chối thu hồi lời mời đã dùng. */
export const canRevoke = (status: InvitationStatus): boolean => status !== "accepted";

/** Độ dài mã mời theo hợp đồng; mã ngoài khoảng này chắc chắn sai nên báo ngay, không gọi hub. */
export const isInviteToken = (token: string): boolean => token.length >= 16 && token.length <= 128;

/** Email trong lời mời và email đang đăng nhập có phải một không; hub so không phân biệt hoa thường. */
export const sameEmail = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Tổ chức vừa vào sau khi đăng ký bằng mã mời. Hub tự nhận lời mời ngay lúc đăng ký nên không trả mã tổ chức; người
 * mới chỉ thuộc tổ chức của lời mời, nên tìm theo tên trong lời mời, không có thì lấy tổ chức đầu tiên.
 */
export function joinedOrg<T extends { name: string }>(orgs: readonly T[], orgName: string): T | null {
  return orgs.find((o) => o.name === orgName) ?? orgs[0] ?? null;
}
