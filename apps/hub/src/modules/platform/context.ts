/** Context của mọi request oRPC: chỉ mang header, module tự đọc phiên từ đó. */
export interface RequestContext {
  headers: Headers;
  /** Header thêm vào phản hồi (ResponseHeadersPlugin), vd. `Hive-Client-Event` của thủ tục có ghi. */
  resHeaders?: Headers;
}
