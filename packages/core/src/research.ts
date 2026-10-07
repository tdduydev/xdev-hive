import { z } from "zod";

/** A research request fits in run instructions, so older transports keep it intact. */
export const researchSchema = z.object({
  project: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  topic: z.string().min(1).max(200),
  questions: z.array(z.string().min(1).max(300)).min(1).max(6),
  scope: z.enum(["service", "system", "hub"]).default("service"),
  system: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/).optional(),
  sources: z.array(z.enum(["repo", "hive", "web"])).min(1).max(3),
  format: z.enum(["brief", "comparison", "tasks"]).default("brief"),
  machineId: z.string().min(1).max(200),
  profileId: z.string().max(40).nullable().default(null),
});
export type ResearchInput = z.infer<typeof researchSchema>;
export interface ResearchJob extends ResearchInput { id: number; projects: string[] }
export interface Research {
  id: number;
  input: ResearchInput;
  projects: string[];
  requestId: number;
  machineId: string;
  runId: string | null;
  status: "pending" | "queued" | "running" | "done" | "failed" | "cancelled";
  artifactId: number | null;
  proposalId: number | null;
  docKey: string;
  sources: string[];
  recommendations: string;
  error: string | null;
}
