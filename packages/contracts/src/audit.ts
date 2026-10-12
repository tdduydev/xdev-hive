import { z } from "zod";
import { orgRoute } from "./common.ts";

export const auditActorType = z.enum(["user", "run", "system"]);
export const auditArea = z.enum(["work", "know", "proj", "people", "agent", "other"]);
export const auditSource = z.enum(["web", "mcp", "hub"]);
export const auditResult = z.enum(["ok", "denied"]);
export const auditFilters = z.object({
  range: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(365)]).default(7),
  actorType: auditActorType.optional(),
  actorId: z.string().min(1).max(200).optional(),
  area: auditArea.optional(),
  action: z.string().min(1).max(200).optional(),
  source: auditSource.optional(),
  result: auditResult.optional(),
  q: z.string().max(200).optional(),
});
export const auditQueryInput = auditFilters.extend({
  cursor: z.string().max(2000).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type AuditFilters = z.output<typeof auditFilters>;
export type AuditQueryInput = z.output<typeof auditQueryInput>;
export const auditLogItem = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  actorId: z.string().nullable(),
  actor: z.string(),
  actorType: auditActorType,
  action: z.string(),
  area: auditArea,
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  result: auditResult,
  source: auditSource,
  ip: z.string().nullable(),
});
export type AuditLogItem = z.output<typeof auditLogItem>;
export const auditExportInput = auditFilters.extend({ format: z.enum(["csv", "json"]) });
export type AuditExportInput = z.output<typeof auditExportInput>;
export const auditContract = {
  list: orgRoute("GET", "/v1/audit", "Đọc nhật ký", "audit")
    .input(auditQueryInput)
    .output(z.object({ items: z.array(auditLogItem), nextCursor: z.string().nullable() })),
  export: orgRoute("POST", "/v1/audit/export", "Xuất nhật ký (tối đa 20.000 dòng)", "audit")
    .input(auditExportInput)
    .output(z.file()),
};
