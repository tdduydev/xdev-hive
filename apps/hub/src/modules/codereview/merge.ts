import { eq, sql } from "drizzle-orm";
import { flatGates } from "../knowledge/index.ts";
import type { Jobs, Tx } from "../platform/index.ts";
import { codeReviews } from "./schema.ts";

type ReviewRow = typeof codeReviews.$inferSelect;

export interface ApprovedDeps {
  jobs?: Jobs | undefined;
  publicUrl?: string | undefined;
}

/**
 * Phiên qua hết checkpoint. Hiện chỉ chốt trạng thái; vào hàng merge theo chế độ hiệu lực (FR-027) hoặc báo
 * `code_review.approved` thuộc T050.
 */
export async function onApproved(tx: Tx, review: ReviewRow, _deps: ApprovedDeps): Promise<ReviewRow> {
  const [row] = await tx
    .update(codeReviews)
    .set({ status: "approved", gateIndex: flatGates(review.phases).length, updatedAt: sql`now()` })
    .where(eq(codeReviews.id, review.id))
    .returning();
  return row ?? review;
}
