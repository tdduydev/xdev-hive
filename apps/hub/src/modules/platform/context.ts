/** Context của mọi request oRPC: chỉ mang header, module tự đọc phiên từ đó. */
export interface RequestContext {
  headers: Headers;
}
