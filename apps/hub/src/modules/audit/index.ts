// Nhật ký audit append-only. Module khác chỉ ghi qua recordAudit() trong transaction của mình.
export { type AuditEntry, recordAudit } from "./record.ts";
