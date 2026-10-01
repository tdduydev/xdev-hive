// Which permission an action on a doc takes (roadmap 25), for the pages that show approve buttons.
import { isContextDoc, type Permission } from "@xdev-hive/core";

/** Approving a proposal: what agents read is the context's to approve, any other doc a doc reviewer's. */
export const approvalOf = (key: string, doc?: { paths?: readonly string[]; includeInAgents?: boolean } | null): Permission =>
  isContextDoc(key, doc) ? "contextEdit" : "docApprove";
