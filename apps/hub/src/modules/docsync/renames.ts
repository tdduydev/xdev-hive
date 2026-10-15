import { splitBlocks } from "@xdev-hive/contracts";
import { toLf } from "./content.ts";

export type RenameFile = { path: string; blobSha?: string; content?: string };
export type RenameMatch = { from: string; to: string; method: "blob" | "blocks"; similarity: number };

const byPath = (a: RenameFile, b: RenameFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Provider đã báo rename thì caller bỏ cặp đó trước khi chạy phần dự phòng này. */
export function matchRenames(removed: readonly RenameFile[], added: readonly RenameFile[]): RenameMatch[] {
  const before = [...removed].sort(byPath);
  const after = [...added].sort(byPath);
  const usedBefore = new Set<string>();
  const usedAfter = new Set<string>();
  const matches: RenameMatch[] = [];
  const take = (from: string, to: string, method: RenameMatch["method"], similarity: number) => {
    usedBefore.add(from);
    usedAfter.add(to);
    matches.push({ from, to, method, similarity });
  };
  const blobs = new Map<string, RenameFile[]>();
  for (const file of after) {
    if (file.blobSha) {
      const group = blobs.get(file.blobSha) ?? [];
      group.push(file);
      blobs.set(file.blobSha, group);
    }
  }
  for (const file of before) {
    const target = file.blobSha ? blobs.get(file.blobSha)?.shift() : undefined;
    if (target) take(file.path, target.path, "blob", 1);
  }
  const blocks = (file: RenameFile) => new Set(splitBlocks(toLf(file.content ?? "")));
  const candidates: RenameMatch[] = [];
  const remainingAfter = after.filter((f) => !usedAfter.has(f.path)).map((file) => ({ file, blocks: blocks(file) }));
  for (const from of before.filter((f) => !usedBefore.has(f.path))) {
    const source = blocks(from);
    // Không có nội dung hay toàn khoảng trắng thì không đủ bằng chứng để giữ danh tính tài liệu.
    if (!source.size) continue;
    for (const target of remainingAfter) {
      if (!target.blocks.size) continue;
      let common = 0;
      for (const block of source) if (target.blocks.has(block)) common++;
      const similarity = common / (source.size + target.blocks.size - common);
      if (similarity >= 0.8) candidates.push({ from: from.path, to: target.file.path, method: "blocks", similarity });
    }
  }
  candidates.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      byPath({ path: a.from }, { path: b.from }) ||
      byPath({ path: a.to }, { path: b.to }),
  );
  for (const candidate of candidates) {
    if (!usedBefore.has(candidate.from) && !usedAfter.has(candidate.to)) {
      take(candidate.from, candidate.to, candidate.method, candidate.similarity);
    }
  }
  return matches;
}
