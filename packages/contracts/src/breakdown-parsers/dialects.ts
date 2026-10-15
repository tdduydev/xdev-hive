import type { BreakdownError, BreakdownParser, SdlcBreakdown } from "../sdlc.ts";
import { demote, FENCE, indent, indentOf, oneLine, PROJECT_LINE, splitBody } from "./text.ts";

/**
 * Bộ đọc/ghi của Kiro, OpenSpec, BMAD và AI-DLC (T083). Mỗi phương pháp dịch tài liệu gốc sang cú pháp `hive-tasks`
 * từng dòng một (giữ số dòng để lỗi chỉ đúng chỗ) với mã tạm `T0001…`, để chung một bộ đọc với Hive/Spec Kit; sau khi
 * đọc thì đổi mã tạm về mã gốc (`2`, `1.1`, `Story 1.2`, `unit-3`). Nhờ vậy luật phụ thuộc, dự án, giới hạn và độ phủ
 * giống hệt nhau giữa các phương pháp.
 *
 * Độ mịn `single` không qua lớp này: tài liệu được đọc nguyên văn, checklist thường thành checklist của một task.
 */

type Breakdown = SdlcBreakdown;

export interface Translation {
  /** Tài liệu đã dịch, cùng số dòng với bản gốc. */
  text: string;
  /** Mã tạm → mã gốc. */
  native: ReadonlyMap<string, string>;
}

export interface Dialect {
  /** Mẫu dòng việc cho thông báo "không tìm thấy". */
  example: string;
  /** Cách gọi mã gốc trong thông báo lỗi. */
  label(id: string): string;
  translate(lines: readonly string[]): Translation;
  /** Ghi bản tách độ mịn `item`/`heading` về Markdown của phương pháp. */
  write(breakdown: Breakdown, showProject: (key: string) => boolean): string[];
}

/** Mã tạm 4 chữ số để không trùng mã `T001` có thể nằm sẵn trong tài liệu. */
const SYNTH = /\bT\d{4}\b/g;
// Ký hiệu bọc mã mục con trong dòng checklist: `2_1` thay vì `2.1` để mẫu requirement dạng `\d+\.\d+` (Kiro) không
// nhận nhầm mã mục là requirement.
const MARK = /^⟦(\d+(?:_\d+)*)⟧[ \t]*/;
const MARK_ANY = /⟦(\d+(?:_\d+)*)⟧/g;
const HEADING = /^(#{1,6})[ \t]+/;
const DEP =
  /(?:\*\*|__|_|\*)?(?<![\p{L}\p{N}])(?:phụ thuộc|depends on|dependencies)(?:\*\*|__)?[ \t]*:[ \t]*(?:\*\*|__)?([^·]*?)[ \t]*(?:\*\*|__|_|\*)?[ \t]*(·|$)/iu;

class Synth {
  readonly native = new Map<string, string>();
  private readonly byNative = new Map<string, string>();
  id(native: string): string {
    let t = this.byNative.get(native);
    if (!t) {
      t = `T${String(this.byNative.size + 1).padStart(4, "0")}`;
      this.byNative.set(native, t);
      this.native.set(t, native);
    }
    return t;
  }
}

/** Dòng nằm ngoài khối code và comment HTML (giống bộ đọc chung), chỉ những dòng này mới được dịch. */
function proseMask(lines: readonly string[]): boolean[] {
  let fence: string | null = null;
  let comment = false;
  return lines.map((raw) => {
    if (fence !== null) {
      if (raw.trim().startsWith(fence)) fence = null;
      return false;
    }
    if (comment || raw.trimStart().startsWith("<!--")) {
      comment = comment ? !raw.includes("-->") : !raw.slice(raw.indexOf("<!--") + 4).includes("-->");
      return false;
    }
    const f = FENCE.exec(raw);
    if (f) {
      fence = (f[1] ?? "```").slice(0, 3);
      return false;
    }
    return true;
  });
}

/** Dòng phụ thuộc viết theo mã gốc thành `Phụ thuộc: T0001, T0002` cho bộ đọc chung. */
function rewriteDeps(line: string, refs: (clause: string) => string[]): string {
  const m = DEP.exec(line);
  if (!m) return line;
  const ids = refs(m[1] ?? "");
  const rest = line.slice(m.index + m[0].length);
  return `${line.slice(0, m.index)}Phụ thuộc: ${ids.join(", ") || "không"}${m[2] ? ` · ${rest}` : rest}`;
}

// ---- Kiro -------------------------------------------------------------------------------------------------------

const KIRO_TASK = /^( *)[-*+][ \t]+\[([ xX])\]\*?[ \t]+(\d+(?:\.\d+)*)\.?[ \t]+(.+)$/;

/**
 * Kiro `tasks.md`: `- [ ] 1. Việc` là task, `- [ ] 1.1 Việc con` (thụt vào hoặc không) là checklist của task 1, dòng
 * `_Requirements: 1.1, 2.3_` ghi requirement. Việc con không có task cha thành task riêng.
 */
const kiro: Dialect = {
  example: "- [ ] 1. Mô tả",
  label: (id) => `task ${id}`,
  translate(lines) {
    const synth = new Synth();
    const prose = proseMask(lines);
    const out: string[] = [];
    let owner: string | null = null;
    // Dòng con của việc con dời theo việc con: thụt `from` gốc thành `to`.
    let shift: { from: number; to: number } | null = null;
    const refs = (clause: string) =>
      [...clause.matchAll(/(?<![\w.])\d+(?:\.\d+)*(?![\w.]*\d)/g)]
        .map((m) => m[0])
        .filter((r) => !(owner !== null && r.includes(".") && r.split(".")[0] === owner))
        .map((r) => synth.id(r.split(".")[0] ?? r));
    for (const [i, raw] of lines.entries()) {
      if (shift && raw.trim() !== "" && indentOf(raw) <= shift.from) shift = null;
      const m = prose[i] ? KIRO_TASK.exec(raw) : null;
      const depth = m ? (m[3] ?? "").split(".").length : 0;
      if (m && depth === 1 && (m[1] ?? "").length <= 1) {
        owner = m[3] ?? "";
        shift = null;
        out.push(`- [${m[2]}] ${synth.id(owner)} ${m[4]}`);
        continue;
      }
      if (m && depth > 1) {
        const id = m[3] ?? "";
        const from = (m[1] ?? "").length;
        if (owner !== null && id.split(".")[0] === owner) {
          out.push(`  - [${m[2]}] ⟦${id.replaceAll(".", "_")}⟧ ${m[4]}`);
          shift = { from, to: 4 };
        } else {
          owner = id;
          out.push(`- [${m[2]}] ${synth.id(id)} ${m[4]}`);
          shift = { from, to: 2 };
        }
        continue;
      }
      let line = raw;
      if (shift && raw.trim() !== "")
        line = `${" ".repeat(Math.max(shift.to, shift.to + indentOf(raw) - shift.from - 2))}${raw.trimStart()}`;
      out.push(prose[i] ? rewriteDeps(line, refs) : line);
    }
    return { text: out.join("\n"), native: synth.native };
  },
  write(breakdown, showProject) {
    const keys = renumber(
      breakdown.tasks.map((t) => t.sliceKey),
      (k) => /^\d+$/.test(k),
    );
    const out = ["# Implementation Plan", ""];
    for (const t of breakdown.tasks) {
      const key = keys.get(t.sliceKey) ?? t.sliceKey;
      const tag = showProject(t.project) ? ` [@${t.project}]` : "";
      out.push(`- [ ] ${key}.${t.parallel ? " [P]" : ""}${tag} ${oneLine(t.title)}`);
      const body = t.body === "" ? [] : t.body.split("\n");
      const deps = t.dependsOn.map((d) => keys.get(d) ?? d);
      if (deps.length > 0) body.push(`- _Depends on: ${deps.join(", ")}_`);
      out.push(...indent(body), ...t.checklist.map((c, k) => `  - [ ] ${key}.${k + 1} ${oneLine(c.text)}`), "");
    }
    return out;
  },
};

// ---- OpenSpec ---------------------------------------------------------------------------------------------------

const OPENSPEC_SECTION = /^(#{2,3})[ \t]+(\d+)\.?[ \t]+(.+?)[ \t]*$/;
const OPENSPEC_ITEM = /^( ?)[-*+][ \t]+\[([ xX])\][ \t]+(\d+(?:\.\d+)+)\.?[ \t]+(.+)$/;

/**
 * OpenSpec `tasks.md`: phần `## 1. Chuẩn bị`, mục `- [ ] 1.1 Việc`. Mỗi phần là một task (khoá lát là số phần), mục là
 * checklist. Phụ thuộc ghi số phần (`**Phụ thuộc**: 1`) hoặc mã mục.
 */
const openspec: Dialect = {
  example: "## 1. Phần và - [ ] 1.1 Mô tả",
  label: (id) => (id.includes(".") ? `mục ${id}` : `phần ${id}`),
  translate(lines) {
    const synth = new Synth();
    const prose = proseMask(lines);
    // Phụ thuộc vào cả phần trỏ tới mục đầu của phần đó; bộ đọc chung tự đổi mục thành phần.
    const firstOf = new Map<string, string>();
    let section: string | null = null;
    for (const [i, raw] of lines.entries()) {
      if (!prose[i]) continue;
      const s = OPENSPEC_SECTION.exec(raw);
      if (s) section = s[2] ?? null;
      else if (HEADING.test(raw)) section = null;
      const it = OPENSPEC_ITEM.exec(raw);
      if (it && section !== null && !firstOf.has(section)) firstOf.set(section, it[3] ?? "");
    }
    const refs = (clause: string) =>
      [...clause.matchAll(/(?<![\w.])\d+(?:\.\d+)*(?![\w.]*\d)/g)].map((m) => synth.id(firstOf.get(m[0]) ?? m[0]));
    const out = lines.map((raw, i) => {
      if (!prose[i]) return raw;
      const s = OPENSPEC_SECTION.exec(raw);
      if (s) return `${s[1]} ${(s[3] ?? "").replace(/[ \t]*\{#[^}]*\}$/, "")} {#${s[2]}}`;
      const it = OPENSPEC_ITEM.exec(raw);
      if (it) return `${it[1]}- [${it[2]}] ${synth.id(it[3] ?? "")} ${it[4]}`;
      return rewriteDeps(raw, refs);
    });
    return { text: out.join("\n"), native: synth.native };
  },
  write(breakdown, showProject) {
    const keys = renumber(
      breakdown.tasks.map((t) => t.sliceKey),
      (k) => /^\d+$/.test(k),
    );
    const out = ["# Tasks", ""];
    for (const t of breakdown.tasks) {
      const key = keys.get(t.sliceKey) ?? t.sliceKey;
      const { preamble, blocks } = splitBody(t.body);
      out.push(`## ${key}. ${oneLine(t.title)}`, "");
      if (showProject(t.project)) out.push(`Dự án: ${t.project}`);
      if (t.dependsOn.length > 0) out.push(`**Phụ thuộc**: ${t.dependsOn.map((d) => keys.get(d) ?? d).join(", ")}`);
      out.push("", ...demote(preamble), "");
      // Phần rỗng vẫn có một mục để đọc lại không mất phần.
      const items = t.checklist.length > 0 ? t.checklist : [{ id: "", text: t.title }];
      for (const [k, c] of items.entries()) {
        out.push(`- [ ] ${key}.${k + 1} ${oneLine(c.text)}`, ...indent(blocks.get(c.id) ?? []));
      }
      out.push("");
    }
    return out;
  },
};

// ---- BMAD, AI-DLC: mỗi tiêu đề là một task ----------------------------------------------------------------------

interface HeadingItems {
  /** Tiêu đề tài liệu khi ghi. */
  title: string;
  /** Tiêu đề task; nhóm 1 là dấu `#`, nhóm 2 là số, nhóm 3 là tên. */
  heading: RegExp;
  nativeOf(num: string): string;
  refs: RegExp;
  writeHeading(key: string, title: string): string;
  /** Khoá cho task mới thêm trên màn duyệt. */
  newKey(used: ReadonlySet<string>): string;
  isNative(key: string): boolean;
}

/**
 * Story/Unit viết bằng tiêu đề: nội dung tới tiêu đề cùng cấp trở lên là chi tiết của task, nên dịch thành dòng task
 * và thụt nội dung vào. Dòng `Dự án:` trong story thành thẻ `[@key]` của task (ngoài story vẫn áp cho cả phần).
 */
function headingItems(spec: HeadingItems, rest: Pick<Dialect, "example" | "label">): Dialect {
  return {
    ...rest,
    translate(lines) {
      const synth = new Synth();
      const prose = proseMask(lines);
      const refs = (clause: string) =>
        [...clause.matchAll(spec.refs)].map((m) => synth.id(spec.nativeOf(m[1] ?? m[0])));
      const out: string[] = [];
      let story: { level: number; at: number } | null = null;
      for (const [i, raw] of lines.entries()) {
        const h = prose[i] ? HEADING.exec(raw) : null;
        if (story && h && (h[1] ?? "").length <= story.level) story = null;
        const m = prose[i] ? spec.heading.exec(raw) : null;
        if (m) {
          const num = m[2] ?? "";
          story = { level: (m[1] ?? "").length, at: out.length };
          out.push(`- [ ] ${synth.id(spec.nativeOf(num))} ${(m[3] ?? "").trim() || spec.nativeOf(num)}`);
          continue;
        }
        const project = story && prose[i] ? PROJECT_LINE.exec(raw) : null;
        if (story && project) {
          out[story.at] += ` [@${project[1]}]`;
          out.push("");
          continue;
        }
        const line = prose[i] ? rewriteDeps(raw, refs) : raw;
        out.push(story && line !== "" ? `  ${line}` : line);
      }
      return { text: out.join("\n"), native: synth.native };
    },
    write(breakdown, showProject) {
      const used = new Set(breakdown.tasks.map((t) => t.sliceKey).filter(spec.isNative));
      const keys = new Map<string, string>();
      for (const t of breakdown.tasks) {
        if (spec.isNative(t.sliceKey)) keys.set(t.sliceKey, t.sliceKey);
        else {
          const k = spec.newKey(used);
          used.add(k);
          keys.set(t.sliceKey, k);
        }
      }
      const out = [`# ${spec.title}`, ""];
      for (const t of breakdown.tasks) {
        const key = keys.get(t.sliceKey) ?? t.sliceKey;
        out.push(spec.writeHeading(key, `${t.parallel ? "[P] " : ""}${oneLine(t.title)}`), "");
        if (showProject(t.project)) out.push(`Dự án: ${t.project}`);
        if (t.dependsOn.length > 0) {
          const deps = t.dependsOn.map((d) => keys.get(d) ?? d);
          out.push(`**Phụ thuộc**: ${deps.map((d) => rest.label(d)).join(", ")}`);
        }
        out.push("", ...demote(t.body === "" ? [] : t.body.split("\n")), "");
        out.push(...t.checklist.map((c) => `- [ ] ${oneLine(c.text)}`), "");
      }
      return out;
    },
  };
}

const bmad = headingItems(
  {
    title: "Epics và Stories",
    heading: /^(#{2,4})[ \t]+Story[ \t]+(\d+\.\d+)[ \t]*(?:[:.\-–—][ \t]*)?(.*?)[ \t]*$/i,
    nativeOf: (num) => num,
    refs: /(?<![\w.])(\d+\.\d+)(?![\w.]*\d)/g,
    writeHeading: (key, title) => `## Story ${key}: ${title}`,
    newKey(used) {
      const nums = [...used].map((k) => k.split(".").map(Number) as [number, number]);
      const epic = nums.at(-1)?.[0] ?? 1;
      const next = Math.max(0, ...nums.filter(([e]) => e === epic).map(([, s]) => s)) + 1;
      return `${epic}.${next}`;
    },
    isNative: (key) => /^\d+\.\d+$/.test(key),
  },
  { example: "### Story 1.1: Tiêu đề", label: (id) => `Story ${id}` },
);

const aidlc = headingItems(
  {
    title: "Units of Work",
    heading: /^(#{2,4})[ \t]+(?:Unit|Đơn vị)[ \t]+(\d+)[ \t]*(?:[:.\-–—][ \t]*)?(.*?)[ \t]*$/iu,
    nativeOf: (num) => `unit-${num}`,
    refs: /(?<![\p{L}\p{N}_])(?:unit|đơn vị)[ \t-]*(\d+)(?![\p{L}\p{N}_])/giu,
    writeHeading: (key, title) => `## Unit ${key.slice("unit-".length)}: ${title}`,
    newKey(used) {
      return `unit-${Math.max(0, ...[...used].map((k) => Number(k.slice("unit-".length)))) + 1}`;
    },
    isNative: (key) => /^unit-\d+$/.test(key),
  },
  { example: "## Unit 1: Tên", label: (id) => `Unit ${id.replace(/^unit-/, "")}` },
);

export const DIALECTS: Readonly<Partial<Record<BreakdownParser, Dialect>>> = {
  "kiro-tasks": kiro,
  "openspec-tasks": openspec,
  "bmad-stories": bmad,
  "aidlc-units": aidlc,
};

// ---- Đổi mã tạm về mã gốc ---------------------------------------------------------------------------------------

export function restoreBreakdown(breakdown: Breakdown, t: Translation): Breakdown {
  const back = (id: string) => t.native.get(id) ?? id;
  const item = breakdown.granularity === "item";
  const tasks = breakdown.tasks.map((task) => {
    const sliceKey = item ? back(task.sliceKey) : task.sliceKey;
    const used = new Set<string>();
    const marked = task.checklist.map((c) => {
      const m = MARK.exec(c.text);
      const id = m ? (m[1] ?? "").replaceAll("_", ".") : null;
      if (id) used.add(id);
      return { ...c, id, text: m ? c.text.slice(m[0].length) : c.text };
    });
    // Mục không mang mã gốc (checklist thường trong story) đánh số theo task: `1.2.1`, `unit-3.2`.
    let n = 0;
    const checklist = marked.map((c, k) => {
      if (c.id) return { ...c, id: c.id };
      if (!item) return { ...c, id: back(task.checklist[k]?.id ?? "") };
      let id: string;
      do id = `${sliceKey}.${++n}`;
      while (used.has(id));
      used.add(id);
      return { ...c, id };
    });
    const body = task.body
      .replace(/^#### (T\d{4})$/gm, (_m, id: string) => `#### ${back(id)}`)
      .replace(MARK_ANY, (_m, id: string) => id.replaceAll("_", "."));
    return {
      ...task,
      sliceKey,
      body,
      checklist,
      dependsOn: item ? task.dependsOn.map(back) : task.dependsOn,
    };
  });
  const waves = item ? breakdown.waves.map((w) => w.map(back)) : breakdown.waves;
  return { ...breakdown, tasks, waves };
}

export function restoreErrors(errors: readonly BreakdownError[], t: Translation, d: Dialect): BreakdownError[] {
  return errors.map((e) => ({
    ...e,
    message: e.message.replace(SYNTH, (id) => (t.native.has(id) ? d.label(t.native.get(id) ?? id) : id)),
  }));
}

/** Khoá số giữ nguyên; khoá khác (task thêm trên màn duyệt) nhận số tiếp theo. */
function renumber(keys: readonly string[], numeric: (k: string) => boolean): Map<string, string> {
  let next = Math.max(0, ...keys.filter(numeric).map(Number));
  return new Map(keys.map((k) => [k, numeric(k) ? k : String(++next)]));
}
