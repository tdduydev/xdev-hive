import type { StoreStatus } from "@/lib/secrets.ts";
import { invoke } from "@/lib/tauri.ts";

/**
 * Credential triển khai (specs/032 FR-060…FR-066): Jenkins, Argo CD. Kho và danh mục riêng với bí mật của dự án, không
 * gán được cho dự án. Giá trị chỉ đi một chiều vào `deliveryCredSave`; không có lệnh nào trả giá trị về giao diện.
 */

export interface DeliveryCredential {
  name: string;
  createdAt: string;
  valueChangedAt: string;
}

export interface DeliveryCredentialsList {
  /** Đăng ký worker sở hữu các credential này (`reg_…`); worker chỉ đọc credential của đăng ký mình. */
  registration: string;
  credentials: DeliveryCredential[];
}

export const DELIVERY_NAME_MAX_LENGTH = 64;

/** Cùng mẫu với worker (secretstore.ValidDeliveryName); kiểm trước để báo ngay trong form, worker kiểm lại. */
export const isValidDeliveryName = (name: string): boolean => /^[a-z0-9-]{1,64}$/.test(name);

export const deliveryCredsStatus = () => invoke<StoreStatus>("delivery_creds_status");
export const deliveryCredsList = () => invoke<DeliveryCredentialsList>("delivery_creds_list");
export const deliveryCredSave = (name: string, value: string) =>
  invoke<DeliveryCredential>("delivery_cred_save", { name, value });
export const deliveryCredDelete = (name: string) => invoke<{ deleted: string }>("delivery_cred_delete", { name });
