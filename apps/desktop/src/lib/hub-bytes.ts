import { invoke } from "@/lib/tauri.ts";

interface BytesReply {
  status: number;
  contentType: string;
  base64: string;
}

/**
 * Đọc byte của file trên hub qua lệnh Rust `hub_fetch_bytes`: token cá nhân nằm trong keychain nên thẻ `<img>` hay
 * `fetch` của giao diện không gọi thẳng hub được. Rust chỉ nhận đường dẫn file tài liệu (ảnh, file Word); mã lỗi của
 * hub trả nguyên trong `status`.
 */
export async function hubFetchBytes(path: string): Promise<{ status: number; contentType: string; bytes: Uint8Array }> {
  const reply = await invoke<BytesReply>("hub_fetch_bytes", { path });
  const binary = atob(reply.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { status: reply.status, contentType: reply.contentType, bytes };
}

/** Ảnh nhúng dạng `data:`: CSP của app chỉ cho `img-src 'self' data:`, không cho `blob:`. */
export async function hubFetchImage(path: string): Promise<string | null> {
  const reply = await invoke<BytesReply>("hub_fetch_bytes", { path });
  const type = reply.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (reply.status < 200 || reply.status >= 300 || !/^image\/(png|jpe?g|gif|webp|avif)$/.test(type)) return null;
  return `data:${type};base64,${reply.base64}`;
}
