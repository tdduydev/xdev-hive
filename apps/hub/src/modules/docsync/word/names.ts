// Đặt tên và chọn phiên bản cho lượt nhập Word (FR-006, Q4, plan.md mục 4). Hàm thuần: không đọc DB, không gọi pandoc.
// Kết quả không phụ thuộc thứ tự đầu vào vì thứ tự đọc thư mục của hệ điều hành khác nhau (lỗi đã gặp ở srs2md).

/** Phần mở rộng nhận vào (FR-002). Chỉ cắt đúng các đuôi này để "v1.0" không bị nhầm là đuôi file. */
const WORD_EXT = /\.(?:docx|doc|odt)$/i;

// Phiên bản đứng cuối tên: [phân cách] v<số>(.<số>)* [_<số bản sao>] [phân cách].
// Khác plan.md ở chỗ `v` không được đứng sau một chữ cái, để "Nov1" không thành "No" + v1; "OPD17v1.2" vẫn nhận.
const VERSION_TAIL = /[ _-]*(?<![A-Za-z])v(\d+(?:\.\d+)*)(?:_(\d+))?[ -]*$/i;

// Tiền tố lạ đã gặp trong bộ SRS thật (research.md mục 1). Quy tắc riêng từng nhà để P3 (Q4).
const NOISE_PREFIX = /^hc[ _-]+(?=.)/i;

const SEGMENT = /[^ _.-]+[ _.-]*/g;

const FALLBACK_NAME = "tai-lieu";

export interface NameParts {
  /** Tên bỏ đuôi file và đuôi phiên bản. */
  stem: string;
  /** Đuôi file như đã gõ (`.docx`), rỗng nếu không phải đuôi Word. */
  ext: string;
  /** Nhãn phiên bản không có chữ `v` (`1.0`), null nếu tên không ghi phiên bản. */
  version: string | null;
  /** Số bản sao `_n` sau phiên bản; 0 là bản gốc. */
  copy: number;
}

export function stripVersion(fileName: string): NameParts {
  const ext = WORD_EXT.exec(fileName)?.[0] ?? "";
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  const match = VERSION_TAIL.exec(base);
  const stem = match ? base.slice(0, match.index) : base;
  // "v1.docx" chỉ có phiên bản: giữ nguyên làm tên còn hơn là tên rỗng.
  if (!match || stem === "") return { stem: base, ext, version: null, copy: 0 };
  return { stem, ext, version: match[1] ?? null, copy: match[2] ? Number(match[2]) : 0 };
}

export function stripNoisePrefix(stem: string): { stem: string; standard: boolean } {
  const rest = stem.replace(NOISE_PREFIX, "");
  return { stem: rest, standard: rest === stem };
}

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Một đoạn là chữ cùng các dấu phân cách theo sau; `.`, `_`, `-`, dấu cách tính như nhau vì tên SRS lẫn cả bốn. */
const segmentsOf = (name: string): string[] => name.match(SEGMENT) ?? [];
const keyOf = (segment: string): string => segment.replace(/[ _.-]+$/, "").toLowerCase();

/** Số đoạn đầu chung của cả nhóm, hoặc 0 khi không được áp dụng (ít hơn 2 tên khác nhau, hoặc có tên hết trước phần chung). */
function commonSegments(names: readonly string[]): { count: number; first: string } {
  const distinct = new Map<string, string>();
  for (const name of names) {
    const key = segmentsOf(name).map(keyOf).join("\0");
    const kept = distinct.get(key);
    if (kept === undefined || name < kept) distinct.set(key, name);
  }
  if (distinct.size < 2) return { count: 0, first: "" };
  const lists = [...distinct.values()].sort(text).map(segmentsOf);
  const [head = [], ...others] = lists;
  let count = 0;
  while (
    count < head.length &&
    others.every((list) => list[count] !== undefined && keyOf(list[count] ?? "") === keyOf(head[count] ?? ""))
  ) {
    count++;
  }
  if (lists.some((list) => list.length <= count)) return { count: 0, first: "" };
  return { count, first: head.slice(0, count).join("") };
}

/**
 * Phần đầu chung dài nhất của các tên, cắt ở ranh giới đoạn. Chỉ áp dụng khi có từ 2 tên khác nhau và phần còn lại của
 * mọi tên không rỗng. Trả về theo tên đứng đầu theo mã ký tự; chuỗi rỗng là không áp dụng.
 */
export function commonPrefix(names: readonly string[]): string {
  return commonSegments(names).first;
}

/** Bỏ `commonPrefix` khỏi từng tên, giữ thứ tự đầu vào. Không áp dụng thì trả lại nguyên tên. */
export function dropCommonPrefix(names: readonly string[]): string[] {
  const { count } = commonSegments(names);
  return names.map((name) => (count === 0 ? name : segmentsOf(name).slice(count).join("")));
}

/** Bỏ dấu tiếng Việt, ký tự lạ thành `-`, giữ hoa thường. */
function ascii(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Dạng chữ thường không dấu, đủ để ghép vào `docKey`. Cũng dùng để nhận ra hai tên là một tài liệu. */
export function slug(name: string): string {
  return ascii(name).toLowerCase() || FALLBACK_NAME;
}

/**
 * Đường dẫn file đề xuất: `<thư mục đích>/<thư mục con>/<tên>.md`. Giữ hoa thường vì doc_repo_files giữ đúng đường dẫn
 * đã chọn (`OPD17.md`), còn key tài liệu hạ chữ thường sau. Thư mục con bị làm sạch như tên, `.` và `..` bị bỏ để không
 * thoát khỏi thư mục đích.
 */
export function proposePath(targetDir: string, relativeDir: string, name: string): string {
  const target = targetDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const dirs = relativeDir
    .split(/[\\/]+/)
    .map(ascii)
    .filter(Boolean);
  return [target, ...dirs, `${ascii(name) || FALLBACK_NAME}.md`].filter(Boolean).join("/");
}

/** Phiên bản so theo từng số; thiếu số coi là 0 (`1.0` bằng `1.0.0`); không ghi phiên bản thấp hơn mọi phiên bản. */
function compareVersions(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type PickReason = "version" | "copy" | "standard" | "modified" | "filename";

interface Candidate<T> {
  item: T;
  name: string;
  parts: NameParts;
  standard: boolean;
  modified: number;
}

/** Âm khi `a` đứng trước `b` (tốt hơn): phiên bản → bản sao _n → tên chuẩn → ngày sửa → tên file. */
function rank<T>(a: Candidate<T>, b: Candidate<T>): { order: number; reason: PickReason } {
  const steps: [PickReason, number][] = [
    ["version", compareVersions(b.parts.version, a.parts.version)],
    ["copy", a.parts.copy - b.parts.copy],
    ["standard", Number(b.standard) - Number(a.standard)],
    ["modified", b.modified === a.modified ? 0 : b.modified > a.modified ? 1 : -1],
    ["filename", text(a.name, b.name)],
  ];
  for (const [reason, order] of steps) if (order !== 0) return { order, reason };
  return { order: 0, reason: "filename" };
}

const coreOf = (parts: NameParts): { core: string; standard: boolean } => {
  const { stem, standard } = stripNoisePrefix(parts.stem);
  return { core: stem, standard };
};

interface Picked<T> {
  kept: T[];
  dropped: { file: T; winner: T; reason: PickReason }[];
}

/** Chọn một bản cho mỗi tài liệu trong cùng một thư mục; `nameOf` là tên file không kèm thư mục. */
function pickWith<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  modifiedOf: (item: T) => number | undefined,
): Picked<T> {
  const groups = new Map<string, Candidate<T>[]>();
  for (const item of items) {
    const name = nameOf(item);
    const parts = stripVersion(name);
    const { core, standard } = coreOf(parts);
    const candidate = { item, name, parts, standard, modified: modifiedOf(item) ?? Number.NEGATIVE_INFINITY };
    const key = slug(core);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const kept: Candidate<T>[] = [];
  const dropped: { candidate: Candidate<T>; winner: Candidate<T>; reason: PickReason }[] = [];
  for (const group of groups.values()) {
    const [winner, ...losers] = [...group].sort((a, b) => rank(a, b).order);
    if (!winner) continue;
    kept.push(winner);
    for (const candidate of losers) dropped.push({ candidate, winner, reason: rank(candidate, winner).reason });
  }
  const byName = (a: { name: string }, b: { name: string }) => text(a.name, b.name);
  return {
    kept: kept.sort(byName).map((c) => c.item),
    dropped: dropped
      .sort((a, b) => byName(a.candidate, b.candidate))
      .map((d) => ({ file: d.candidate.item, winner: d.winner.item, reason: d.reason })),
  };
}

export interface PickFile {
  /** Tên file, không kèm thư mục. */
  name: string;
  /** `lastModified` của trình duyệt (ms). */
  lastModified?: number;
}

/** Chọn bản cao nhất cho mỗi tài liệu trong cùng một thư mục, kèm lý do bỏ các bản còn lại (FR-006). */
export function pick<T extends PickFile>(files: readonly T[]): Picked<T> {
  return pickWith(
    files,
    (file) => file.name,
    (file) => file.lastModified,
  );
}

export interface PlanFile {
  /** Đường dẫn tương đối trong thư mục được kéo vào, `/` hoặc `\`. */
  path: string;
  lastModified?: number;
}

export interface PlannedName<T> {
  file: T;
  /** Đường dẫn file Markdown đề xuất trong repo. */
  path: string;
  version: string | null;
}

/**
 * Gộp các bước theo FR-006: chọn bản trong từng thư mục, bỏ phần đầu chung của các bản được giữ (tính riêng từng thư
 * mục), rồi đề xuất đường dẫn dưới `targetDir`.
 */
export function planNames<T extends PlanFile>(
  files: readonly T[],
  targetDir: string,
): { planned: PlannedName<T>[]; dropped: Picked<T>["dropped"] } {
  const byDir = new Map<string, { file: T; name: string }[]>();
  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");
    const cut = path.lastIndexOf("/");
    const dir = cut < 0 ? "" : path.slice(0, cut);
    byDir.set(dir, [...(byDir.get(dir) ?? []), { file, name: path.slice(cut + 1) }]);
  }

  const planned: PlannedName<T>[] = [];
  const dropped: Picked<T>["dropped"] = [];
  for (const [dir, entries] of byDir) {
    const picked = pickWith(
      entries,
      (entry) => entry.name,
      (entry) => entry.file.lastModified,
    );
    const cores = picked.kept.map((entry) => coreOf(stripVersion(entry.name)).core);
    const names = dropCommonPrefix(cores);
    picked.kept.forEach((entry, i) => {
      planned.push({
        file: entry.file,
        path: proposePath(targetDir, dir, names[i] ?? ""),
        version: stripVersion(entry.name).version,
      });
    });
    for (const d of picked.dropped) dropped.push({ file: d.file.file, winner: d.winner.file, reason: d.reason });
  }
  const byPath = (a: { file: PlanFile }, b: { file: PlanFile }) => text(a.file.path, b.file.path);
  return { planned: planned.sort(byPath), dropped: dropped.sort(byPath) };
}
