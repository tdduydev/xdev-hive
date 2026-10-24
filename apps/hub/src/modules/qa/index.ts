// Module quản lý kiểm thử (specs/036). Các task sau export thêm hook tài liệu và provider quyền lưu.
export type { QaDeps, QaRouteDeps } from "./deps.ts";
export { qaDocAccess, qaDocSaved } from "./doc-hooks.ts";
export { qaRouter } from "./router.ts";
