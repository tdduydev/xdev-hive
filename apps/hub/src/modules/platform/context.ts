/** Context của mọi request oRPC: chỉ mang header, module tự đọc phiên từ đó. */
export interface RequestContext {
  headers: Headers;
  /** Địa chỉ socket của kết nối; cùng `HIVE_TRUSTED_PROXIES` quyết định có tin `X-Forwarded-For` không. */
  remoteAddress?: string | undefined;
  /** Header thêm vào phản hồi (ResponseHeadersPlugin), vd. `Hive-Client-Event` của thủ tục có ghi. */
  resHeaders?: Headers;
}
