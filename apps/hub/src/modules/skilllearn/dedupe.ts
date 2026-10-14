// Bỏ đề xuất trùng (specs/014 FR-006): so tên, mô tả và nội dung bằng tập từ, không gọi mô hình. Embedding và FTS của
// memory dùng được nhưng đắt hơn và cần database có pgvector; so tập từ đủ để chặn trùng rõ ràng ở lô nhỏ mỗi ngày.

/** Tách từ theo chữ và số Unicode (có dấu tiếng Việt), bỏ từ quá ngắn để “và”, “is” không làm hai câu giống nhau. */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u))
    if (w.length >= 3) out.add(w);
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
}

/** Phần của `a` nằm trong `b` (a ngắn hơn: mô tả đề xuất so với memory dài hơn). */
export function containment(a: Set<string>, b: Set<string>): number {
  if (!a.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / a.size;
}

export const SKILL_SIMILARITY = 0.6;
export const MEMORY_CONTAINMENT = 0.8;
/** Dưới số từ này thì mô tả quá ngắn để kết luận “đã có trong memory”. */
const MIN_MEMORY_TOKENS = 6;

export interface NamedText {
  name: string;
  description: string;
}

export type DuplicateKind = "skill" | "pack" | "memory" | "rejected" | "pending";

export interface DuplicateHit {
  kind: DuplicateKind;
  /** Tên skill, hoặc id memory. */
  ref: string;
  score: number;
}

export interface DedupeCorpus {
  skills: NamedText[];
  packNames: string[];
  memories: { id: string; content: string }[];
  /** Đề xuất của dự án đã bị từ chối: không đề xuất lại. */
  rejected: NamedText[];
  /** Đề xuất của dự án đang chờ duyệt. */
  pending: NamedText[];
}

const textOf = (x: NamedText) => `${x.name.replaceAll("-", " ")} ${x.description}`;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Đề xuất `new` trùng cái đã có thì trả lý do đầu tiên khớp. Đề xuất `edit` chỉ so với đề xuất bị từ chối và đang chờ
 * (nó vốn sửa skill đã có), nên người gọi truyền `skipExisting`.
 */
export function findDuplicate(
  candidate: NamedText,
  corpus: DedupeCorpus,
  opts: { skipExisting?: boolean } = {},
): DuplicateHit | null {
  const own = tokens(textOf(candidate));
  const scan = (list: NamedText[], kind: DuplicateKind): DuplicateHit | null => {
    for (const x of list) {
      if (sameName(x.name, candidate.name)) return { kind, ref: x.name, score: 1 };
      const score = jaccard(own, tokens(textOf(x)));
      if (score >= SKILL_SIMILARITY) return { kind, ref: x.name, score };
    }
    return null;
  };
  if (!opts.skipExisting) {
    const pack = corpus.packNames.find((n) => sameName(n, candidate.name));
    if (pack) return { kind: "pack", ref: pack, score: 1 };
    const skill = scan(corpus.skills, "skill");
    if (skill) return skill;
    const description = tokens(`${candidate.name.replaceAll("-", " ")} ${candidate.description}`);
    if (description.size >= MIN_MEMORY_TOKENS) {
      for (const m of corpus.memories) {
        const score = containment(description, tokens(m.content));
        if (score >= MEMORY_CONTAINMENT) return { kind: "memory", ref: m.id, score };
      }
    }
  }
  return scan(corpus.rejected, "rejected") ?? scan(corpus.pending, "pending");
}

const REASON: Record<DuplicateKind, string> = {
  skill: "đã có skill",
  pack: "trùng skill mặc định",
  memory: "đã có trong memory",
  rejected: "đã bị từ chối trước đó",
  pending: "đang chờ duyệt",
};

export const duplicateReason = (hit: DuplicateHit) => `${REASON[hit.kind]} ${hit.ref}`;
