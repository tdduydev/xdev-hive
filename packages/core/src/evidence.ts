import { z } from "zod";
import { SPEC_DIR } from "#core/speckit.ts";

export const evidenceSourceSchema = z.object({ specDir: z.string().regex(SPEC_DIR), specBranch: z.string().max(200) });
export type EvidenceContext = z.infer<typeof evidenceScopeSchema> & z.infer<typeof evidenceSourceSchema> & { specText: string };

/** A result is bound to both the spec bytes and the code revision; neither may silently inherit an old pass. */
export const evidenceScopeSchema = z.object({
  project: z.string().min(1).max(100),
  taskId: z.string().min(1).max(100),
  specHash: z.string().regex(/^[a-f0-9]{64}$/),
  commitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
});
export const evidenceRecordSchema = evidenceScopeSchema.extend(evidenceSourceSchema.shape).extend({
  criterionId: z.string().trim().min(1).max(200),
  criterion: z.string().trim().min(1).max(4000),
  outcome: z.enum(["passed", "failed", "blocked", "untested"]),
  note: z.string().trim().min(1).max(4000),
  artifactIds: z.array(z.number().int().positive()).max(20).default([]).refine(ids => new Set(ids).size === ids.length),
});
export interface EvidenceArtifact {
  id: number;
  name: string;
  sha256: string;
  runId: string;
  machineId: string;
}
export interface AcceptanceEvidence extends z.infer<typeof evidenceRecordSchema> {
  id: number;
  recordedBy: string;
  createdAt: string;
  artifacts: EvidenceArtifact[];
}
