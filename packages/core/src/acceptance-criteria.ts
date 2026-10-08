// Shared parsing keeps the verifier and the server bound to the same criteria in the published spec.
export type CheckGroup = "done" | "check";
export interface CheckItem {
  id: string;
  group: CheckGroup;
  text: string;
  /** The user story or section it is under, when there is one. */
  under: string | null;
  /** Ticked in spec.md itself ("- [x]"). */
  inFile: boolean;
}

const DONE_HEADING = /success criteria|measurable outcomes|done when|definition of done|acceptance criteria|xong khi|tiêu chí/i;
const CHECK_HEADING = /checklist|kiểm thử|kịch bản|test scenarios?|acceptance scenarios?/i;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/;

const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim();
const heading = (s: string) => plain(s.replace(/^#+\s+/, "").replace(/\*\(.*?\)\*/g, ""));

/** A short id for a line that has none of its own, the same for the same words. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * What a spec.md says the feature is done by and how to try it, as Spec Kit's template writes them: the list under
 * "Success Criteria" (SC-001…) is Xong khi; the lines after "**Acceptance Scenarios**:" in each user story, a section
 * named checklist or kiểm thử, and any "- [ ]" line are the checklist. Code blocks are left out.
 */
export function featureChecks(spec: string | null): CheckItem[] {
  const out: CheckItem[] = [];
  const seen = new Set<string>();
  let section: CheckGroup | null = null;
  let story: string | null = null;
  let scenarios = false;
  let fenced = false;
  for (const line of (spec ?? "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h = /^(#{1,6})\s/.exec(line);
    if (h) {
      const name = heading(line);
      const level = h[1]!.length;
      scenarios = false;
      if (DONE_HEADING.test(name)) section = "done";
      else if (CHECK_HEADING.test(name)) section = "check";
      // A sub-heading (### Measurable Outcomes) stays in the section above it; another ## leaves it.
      else if (level <= 2) section = null;
      story = level >= 3 ? name : null;
      continue;
    }
    const label = /^\s*\*\*(.+?)\*\*\s*:?\s*$/.exec(line);
    if (label) {
      // "**Acceptance Scenarios**:" opens the list below it; any other label ("**Independent Test**:") closes it.
      scenarios = CHECK_HEADING.test(label[1]!);
      if (DONE_HEADING.test(label[1]!)) section = "done";
      continue;
    }
    const m = ITEM.exec(line);
    if (!m) continue;
    const box = m[1];
    const group: CheckGroup | null = section === "done" ? "done" : scenarios || section === "check" || box !== undefined ? "check" : null;
    if (!group) continue;
    const text = plain(m[2]!);
    if (!text) continue;
    const own = /^((?:SC|AC|TC|FR)-\d+)\b/.exec(text)?.[1];
    let id = own ?? `${group}-${hash(`${story ?? ""}|${text}`)}`;
    while (seen.has(id)) id = `${id}'`;
    seen.add(id);
    out.push({ id, group, text, under: group === "check" ? story : null, inFile: box === "x" || box === "X" });
  }
  return out;
}

