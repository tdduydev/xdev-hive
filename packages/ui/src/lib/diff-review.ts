import { patchRisks, type DiffReview, type PatchFile } from "@xdev-hive/core";
import type { DiffFile } from "#ui/lib/runlog.ts";

/** Use the parsed lines directly so paths with spaces remain exact. */
export function reviewFiles(files: DiffFile[]): PatchFile[] {
  return files.map(file => {
    const result: PatchFile = { path: file.path, binary: file.binary, hunks: [], metadata: file.metadata };
    for (const line of file.lines) {
      if (line.kind === "hunk") result.hunks.push({ header: line.text, before: "", after: "" });
      else {
        const hunk = result.hunks.at(-1);
        if (!hunk) continue;
        if (line.kind !== "add") hunk.before += `${line.text}\n`;
        if (line.kind !== "del") hunk.after += `${line.text}\n`;
      }
    }
    return result;
  });
}

/** Pin every note to a file and the original unified hunk header, not the group's visual order. */
export function diffFixInstructions(files: PatchFile[], notes: Record<string, string>): string {
  return Object.entries(notes).flatMap(([key, note]) => {
    if (!note.trim() || !/^\d+:\d+$/.test(key)) return [];
    const [fileIndex, hunkIndex] = key.split(":").map(Number);
    const file = files[fileIndex!];
    const hunk = file?.hunks[hunkIndex!];
    return file && hunk ? [`${file.path}\n${hunk.header}\n${note.trim()}`] : [];
  }).join("\n\n");
}

/** Rules are a minimum risk level: an AI flag cannot downgrade a destructive change. */
export function reviewRisks(files: PatchFile[], review?: DiffReview | null): DiffReview["risks"] {
  const risks = (review?.risks ?? []).map(r => ({ ...r }));
  const rank = { low: 0, medium: 1, high: 2 };
  for (const risk of patchRisks(files)) {
    const existing = risks.find(r => r.path === risk.path && r.hunk === risk.hunk && r.kind === risk.kind);
    if (!existing) risks.push(risk);
    else if (rank[existing.level] < rank[risk.level]) existing.level = risk.level;
  }
  return risks;
}
