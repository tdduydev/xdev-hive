import type { Artifact } from "@xdev-hive/core";

export type ArtifactPart = { text: string; artifact?: Artifact };

/** Longest path wins; a bare name shared by several runs opens the newest file in this context. */
export function artifactParts(text: string, files: readonly Artifact[]): ArtifactPart[] {
  const names = new Map<string, Artifact>();
  for (const a of [...files].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)) {
    for (const name of [a.name, `.xdev-hive/artifacts/${a.name}`, a.name.split("/").pop()!]) if (!names.has(name)) names.set(name, a);
  }
  if (!names.size) return [{ text }];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_./-])(${[...names.keys()].sort((a, b) => b.length - a.length).map(escape).join("|")})(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}])`, "gu");
  const parts: ArtifactPart[] = [];
  let pos = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > pos) parts.push({ text: text.slice(pos, match.index) });
    parts.push({ text: match[0], artifact: names.get(match[0]) });
    pos = match.index + match[0].length;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos) });
  return parts;
}

export function textMatches(text: string, query: string): string[] {
  if (!query) return [text];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.split(new RegExp(`(${escaped})`, "gi"));
}
