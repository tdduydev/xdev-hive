import { isCliActionProposalKey, parseDocKey, type Proposal } from "@xdev-hive/core";
import { docOwner, inScope, type Scope } from "#ui/lib/scope.ts";

export function knowledgeProposals(rows: Proposal[], scope: Scope, kind?: "docs" | "skills"): Proposal[] {
  return rows.filter((p) => {
    if (!inScope(scope, docOwner(p.docKey))) return false;
    const parsed = parseDocKey(p.docKey);
    return !kind || (!isCliActionProposalKey(p.docKey) && parsed.skill === (kind === "skills"));
  });
}

export function knowledgeHref(key: string): string {
  return parseDocKey(key).skill ? `#/skills?skill=${encodeURIComponent(key)}` : `#/docs?doc=${encodeURIComponent(key)}`;
}
