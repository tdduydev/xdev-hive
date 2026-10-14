import type { z } from "zod";
import type { BreakdownError, BreakdownParser, breakdownTask, SdlcDecomposition, sdlcBreakdown } from "./sdlc.ts";

/**
 * Bộ đọc/ghi tài liệu tách việc (specs/011 D8, D24): thuần, dùng ở hub (luật `breakdown`, `coverage`, áp baseline) và
 * ở màn Duyệt bản tách. Bản tách là kết quả tính từ Markdown, không lưu nguồn thứ hai. Schema nằm ở sdlc.ts vì nó là
 * một phần của API.
 *
 * Định dạng `hive-tasks` (tasks.md của repo này) và `speckit-tasks` (Spec Kit) cùng một khung:
 * - dòng task `- [ ] T001 [P] [US1] [@web-shop] Mô tả`, dòng thụt vào bên dưới là chi tiết của task;
 * - phụ thuộc: `**Phụ thuộc**: T001, T002 · …` (hive), `(depends on T001)` / `(phụ thuộc T001)` (Spec Kit), hoặc dòng
 *   `**Phụ thuộc**: …` ngay dưới tiêu đề phần (cả phần chờ);
 * - dự án: thẻ `[@key]` trên dòng task hoặc dòng `Dự án: key` dưới tiêu đề phần (áp cho cả phần con).
 * Hai định dạng chỉ khác nhau ở cách bộ ghi viết phụ thuộc.
 */
export type BreakdownTask = z.output<typeof breakdownTask>;
export type Breakdown = z.output<typeof sdlcBreakdown>;

/** Dự án của hạng mục: thẻ `[@key]` ngoài danh sách là lỗi; task không có thẻ thuộc dự án chính. */
export interface BreakdownContext {
  homeProject: string;
  projects: readonly string[];
}

export type BreakdownResult =
  | { ok: true; breakdown: Breakdown; errors: [] }
  | { ok: false; breakdown: null; errors: BreakdownError[] };

/** Độ phủ "đã lên kế hoạch" của bản tách: requirement có ít nhất một task chứa nó. */
export interface BreakdownCoverage {
  total: { requirements: number; planned: number };
  /** Mẫu số là mọi requirement; `planned` là số requirement có task của dự án đó (phần đóng góp của từng làn). */
  byProject: { project: string; requirements: number; planned: number }[];
  /** Requirement chưa có task, theo thứ tự xuất hiện. */
  missing: string[];
}

type Decomposition = Pick<SdlcDecomposition, "parser" | "granularity" | "requirementId" | "maxTasks" | "maxChecklist">;
type ChecklistItem = BreakdownTask["checklist"][number];

// Giới hạn của schema `breakdownTask`: cắt ở đây để bản tách đọc từ tài liệu nào cũng qua được API.
const LIMIT = {
  title: 200,
  body: 20_000,
  item: 500,
  files: 200,
  requirements: 100,
  dependsOn: 50,
  tasks: 100,
} as const;

const SUPPORTED: readonly BreakdownParser[] = ["hive-tasks", "speckit-tasks"];
const SINGLE_KEY = "single";
const ROOT_TITLE = "Chung";

const TASK_ID = /^T\d{3,4}$/;
const TASK_LINE = /^( ?)[-*+][ \t]+\[([ xX])\][ \t]+(T\d{3,4})(?![\w-])[ \t]*(.*)$/;
const CHECK_LINE = /^( ?)[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/;
const SUB_CHECK = /^[-*+][ \t]+\[[ xX]\][ \t]+(.*)$/;
const BULLET = /^(?:[-*+]|\d+[.)])(?:[ \t]|$)/;
const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const EXPLICIT_KEY = /[ \t]*\{#([A-Za-z0-9][\w.-]*)\}[ \t]*$/;
// Chi tiết của từng mục checklist nằm trong body dưới dòng này để bộ ghi đặt lại đúng dưới mục.
const DETAIL_MARK = /^#### (T\d{3,4}|\d+)$/;
const PROJECT_LINE =
  /^[ \t]*(?:[-*][ \t]+)?(?:\*\*|__)?(?:dự án|project)(?:\*\*|__)?[ \t]*:[ \t]*(?:\*\*|__)?[ \t]*`?(?:\[?@)?([A-Za-z0-9][\w.-]*)\]?`?[ \t]*(?:\*\*|__)?[ \t]*\.?[ \t]*$/iu;
const PROJECT_TAG = /\[@([A-Za-z0-9][\w.-]*)\]/g;
const DEP_LABEL =
  /(?:\*\*|__)?(?<![\p{L}\p{N}])(?:phụ thuộc|depends on|dependencies)(?:\*\*|__)?[ \t]*:[ \t]*(?:\*\*|__)?([^·]*?)[ \t]*(?:·[ \t]*|$)/iu;
const DEP_PAREN = /[ \t]*\((?:phụ thuộc|depends on)[ \t]*:?[ \t]*([^)]*)\)/giu;
const HIVE_LEVEL_LINE = /^- \*\*Mức\*\*/;

const KNOWN_EXT = new Set(
  (
    "ts tsx js jsx mjs cjs go rs py java kt swift rb php cs c h cpp hpp sql md mdx json jsonc yaml yml toml html css scss " +
    "sh ps1 proto graphql gql vue svelte dart xml gradle lock mod sum env txt ini conf tf"
  ).split(" "),
);

interface Ref {
  id: string;
  line: number;
  /** Task chứa dòng phụ thuộc; null khi dòng nằm dưới tiêu đề phần. */
  owner: string | null;
}
interface ProjectRef {
  key: string;
  line: number;
}
interface Node {
  level: number;
  title: string;
  key: string | null;
  line: number;
  parent: Node | null;
  project: ProjectRef | null;
  deps: Ref[];
}
interface Detail {
  text: string;
  check: string | null;
}
interface Item {
  id: string;
  line: number;
  parallel: boolean;
  /** Mô tả đã bỏ `[P]`, thẻ dự án và phụ thuộc; giữ `[USn]`. */
  title: string;
  tags: ProjectRef[];
  details: Detail[];
  deps: Ref[];
  node: Node;
}
interface TextLine {
  line: number;
  text: string;
  node: Node;
  heading: boolean;
}
interface Doc {
  root: Node;
  items: Item[];
  texts: TextLine[];
  errors: BreakdownError[];
}

// ---- Đọc --------------------------------------------------------------------------------------------------------

/**
 * Đọc tài liệu tách việc thành bản tách: task, phụ thuộc, đợt (sắp topo), requirement theo `requirementId`, dự án của
 * task. Lỗi có số dòng, viết tiếng Việt ("Dòng 42: T009 phụ thuộc T099 không có.").
 */
export function parseBreakdown(
  markdown: string,
  decomposition: Decomposition,
  context: BreakdownContext,
): BreakdownResult {
  const { parser, granularity } = decomposition;
  if (!SUPPORTED.includes(parser)) return fail([{ line: 0, message: `Bộ đọc “${parser}” chưa có.` }]);
  const requirementsOf = requirementScanner(decomposition.requirementId);
  if (!requirementsOf) return fail([{ line: 0, message: "Mẫu mã requirement không phải regex hợp lệ." }]);

  // Chế độ một task nhận cả checklist thường khi tài liệu không có mã T### (bugfix, small).
  const generic = granularity === "single" && !/^ ?[-*+][ \t]+\[[ xX]\][ \t]+T\d{3,4}(?![\w-])/m.test(markdown);
  const doc = lex(markdown, generic);
  const errors = doc.errors;
  const err = (line: number, message: string) => errors.push({ line, message: `Dòng ${line}: ${message}` });

  if (doc.items.length === 0 && granularity !== "single") {
    errors.push({ line: 0, message: "Không tìm thấy dòng task nào (dạng “- [ ] T001 Mô tả”)." });
    return fail(errors);
  }

  const byId = new Map<string, Item>();
  for (const it of doc.items) {
    const first = byId.get(it.id);
    if (first) err(it.line, `${it.id} trùng với dòng ${first.line}.`);
    else byId.set(it.id, it);
    if (new Set(it.tags.map((t) => t.key)).size > 1) {
      err(it.line, `${it.id} có nhiều thẻ dự án (${it.tags.map((t) => t.key).join(", ")}).`);
    }
  }

  // Mỗi tham chiếu chỉ báo một lần, kể cả dòng dưới tiêu đề phần áp cho nhiều task.
  const usedNodes = new Set<Node>();
  for (const it of doc.items) for (const n of chain(it.node)) usedNodes.add(n);
  for (const ref of [...doc.items.flatMap((it) => it.deps), ...[...usedNodes].flatMap((n) => n.deps)]) {
    const owner = ref.owner ?? nodeLabel(nodeOfRef(ref, usedNodes));
    if (!byId.has(ref.id)) err(ref.line, `${owner} phụ thuộc ${ref.id} không có.`);
    else if (ref.owner === ref.id) err(ref.line, `${ref.id} phụ thuộc chính nó.`);
  }

  const allowed = new Set([context.homeProject, ...context.projects]);
  const projectRefs = [...doc.items.flatMap((it) => it.tags), ...[...usedNodes].flatMap((n) => n.project ?? [])];
  for (const ref of projectRefs) {
    if (!allowed.has(ref.key)) err(ref.line, `dự án ${ref.key} không tham gia hạng mục.`);
  }

  const build = { doc, byId, requirementsOf, home: context.homeProject, err };
  const tasks =
    granularity === "item" ? itemTasks(build) : granularity === "heading" ? headingTasks(build) : [singleTask(build)];

  const { waves, cycle } = breakdownWaves(tasks);
  if (cycle) {
    const at = cycle.reduce((a, b) => (lineOf(tasks, b) < lineOf(tasks, a) ? b : a));
    const start = cycle.indexOf(at);
    const path = [...cycle.slice(start), ...cycle.slice(0, start), at].map((k) => taskLabel(tasks, k, granularity));
    err(lineOf(tasks, at), `phụ thuộc vòng ${path.join(" → ")}.`);
  }

  const maxTasks = Math.min(decomposition.maxTasks, LIMIT.tasks);
  if (tasks.length > maxTasks) {
    const hint = granularity === "item" ? "Gộp theo phần (độ mịn heading)." : "Gộp bớt phần.";
    errors.push({
      line: 0,
      message: `Bản tách có ${tasks.length} task, vượt giới hạn ${maxTasks} của chế độ. ${hint}`,
    });
  }
  for (const t of tasks) {
    if (t.checklist.length > decomposition.maxChecklist) {
      const hint =
        granularity === "item" ? "Tách thành nhiều task." : "Tách thành nhiều phần nhỏ hơn (mỗi phần một task).";
      err(
        t.line,
        `“${t.title}” có ${t.checklist.length} mục checklist, vượt giới hạn ${decomposition.maxChecklist}. ${hint}`,
      );
    }
    if (t.dependsOn.length > LIMIT.dependsOn) err(t.line, `“${t.title}” phụ thuộc quá ${LIMIT.dependsOn} task.`);
  }

  if (errors.length > 0) return fail(errors);
  const requirements = unique(tasks.flatMap((t) => t.requirementIds));
  return { ok: true, breakdown: { parser, granularity, tasks, waves, requirements }, errors: [] };
}

function fail(errors: BreakdownError[]): BreakdownResult {
  const seen = new Set<string>();
  const sorted = errors
    .filter((e) => {
      const k = `${e.line}\u0000${e.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.line - b.line);
  return { ok: false, breakdown: null, errors: sorted };
}

interface Build {
  doc: Doc;
  byId: Map<string, Item>;
  requirementsOf: (texts: readonly string[]) => string[];
  home: string;
  err: (line: number, message: string) => void;
}

function itemTasks({ doc, byId, requirementsOf, home }: Build): BreakdownTask[] {
  return doc.items.map((it) => {
    const checklist: ChecklistItem[] = it.details
      .filter((d) => d.check !== null)
      .map((d, k) => ({
        id: `${it.id}.${k + 1}`,
        text: clip(d.check ?? "", LIMIT.item),
        requirementIds: requirementsOf([d.check ?? ""]),
      }));
    const [title, overflow] = fit(it.title, LIMIT.title);
    const detail = it.details.filter((d) => d.check === null).map((d) => d.text);
    const refs = [...chain(it.node).flatMap((n) => n.deps), ...it.deps].sort((a, b) => a.line - b.line);
    const dependsOn = unique(refs.map((r) => r.id).filter((id) => id !== it.id && byId.has(id)));
    const scan = [it.title, ...it.details.map((d) => d.text)];
    return {
      sliceKey: it.id,
      title,
      body: clip(normalizeBlock(overflow ? [`- Mô tả: ${it.title}`, ...detail] : detail), LIMIT.body),
      project: effectiveProject(it)?.key ?? home,
      requirementIds: requirementsOf(scan).slice(0, LIMIT.requirements),
      checklist,
      dependsOn,
      files: filesOf(scan),
      parallel: it.parallel,
      line: it.line,
    };
  });
}

function headingTasks({ doc, byId, requirementsOf, home, err }: Build): BreakdownTask[] {
  // Mức phần: tiêu đề nông nhất (dưới tiêu đề tài liệu) có task bên dưới; tiêu đề sâu hơn chỉ là chữ trong phần.
  let level = Number.POSITIVE_INFINITY;
  for (const it of doc.items) for (const n of chain(it.node)) if (n.level >= 2) level = Math.min(level, n.level);
  if (level === Number.POSITIVE_INFINITY) level = 1;
  const sectionOf = (node: Node): Node => chain(node).find((n) => n.level <= level) ?? doc.root;

  const sections = new Map<Node, Item[]>();
  for (const it of doc.items) {
    const s = sectionOf(it.node);
    sections.set(s, [...(sections.get(s) ?? []), it]);
  }
  const keyOf = new Map<Node, string>();
  const used = new Set<string>();
  for (const node of sections.keys()) {
    const base = node === doc.root ? slug(ROOT_TITLE) : (node.key ?? (slug(node.title) || `phan-${keyOf.size + 1}`));
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
    used.add(key);
    keyOf.set(node, key);
  }
  const sectionKeyOfItem = new Map<string, string>();
  for (const [node, items] of sections) for (const it of items) sectionKeyOfItem.set(it.id, keyOf.get(node) ?? "");

  return [...sections].map(([node, items]) => {
    const key = keyOf.get(node) ?? "";
    const title = clip(node === doc.root ? ROOT_TITLE : node.title, LIMIT.title);
    const texts = doc.texts.filter((t) => sectionOf(t.node) === node && !(t.heading && t.node === node));
    const { checklist, markers, scan } = checklistOf(items, requirementsOf);

    const ownProject = chain(node).find((n) => n.project)?.project ?? null;
    const project = ownProject?.key ?? items.map(effectiveProject).find((p) => p)?.key ?? home;
    for (const it of items) {
      const p = effectiveProject(it);
      if (p && p.key !== project) {
        err(p.line, `${it.id} thuộc dự án ${p.key}, khác dự án ${project} của phần “${title}”. Tách thành phần riêng.`);
      }
    }

    const sectionRefs = [...chain(node), ...descendants(doc, node, sectionOf)].flatMap((n) => n.deps);
    const refs = [...sectionRefs, ...items.flatMap((it) => it.deps)].sort((a, b) => a.line - b.line);
    const dependsOn = unique(
      refs
        .filter((r) => byId.has(r.id))
        .map((r) => sectionKeyOfItem.get(r.id) ?? "")
        .filter((k) => k !== "" && k !== key),
    );
    const preamble = normalizeBlock(texts.map((t) => t.text));
    const all = [...texts.map((t) => t.text), ...scan];
    return {
      sliceKey: key,
      title,
      body: clip([preamble, ...markers].filter((s) => s !== "").join("\n\n"), LIMIT.body),
      project,
      requirementIds: requirementsOf(all).slice(0, LIMIT.requirements),
      checklist,
      dependsOn,
      files: filesOf(all),
      parallel: items.length > 0 && items.every((it) => it.parallel),
      line: node === doc.root ? (items[0]?.line ?? 1) : node.line,
    };
  });
}

function singleTask({ doc, requirementsOf, home, err }: Build): BreakdownTask {
  const titleNode = firstNode(doc, 1) ?? firstNode(doc, null);
  const texts = doc.texts.filter((t) => !(t.heading && t.node === titleNode));
  const { checklist, markers, scan } = checklistOf(doc.items, requirementsOf);

  const refs = [
    ...doc.items.flatMap((it) => it.tags.slice(0, 1)),
    ...allNodes(doc).flatMap((n) => n.project ?? []),
  ].sort((a, b) => a.line - b.line);
  const project = refs[0]?.key ?? home;
  for (const r of refs) {
    if (r.key !== project) err(r.line, `bản tách một task chỉ thuộc một dự án; ${r.key} khác ${project}.`);
  }
  const preamble = normalizeBlock(texts.map((t) => t.text));
  const all = [...texts.map((t) => t.text), ...scan];
  return {
    sliceKey: SINGLE_KEY,
    title: clip(titleNode?.title || "Việc của hạng mục", LIMIT.title),
    body: clip([preamble, ...markers].filter((s) => s !== "").join("\n\n"), LIMIT.body),
    project,
    requirementIds: requirementsOf(all).slice(0, LIMIT.requirements),
    checklist,
    dependsOn: [],
    files: filesOf(all),
    parallel: false,
    line: titleNode?.line || doc.items[0]?.line || 1,
  };
}

/** Mục checklist của phần: chữ giữ `[P]`, `[USn]` để ghi lại y nguyên; chi tiết chuyển vào body dưới `#### T###`. */
function checklistOf(items: readonly Item[], requirementsOf: (texts: readonly string[]) => string[]) {
  const checklist: ChecklistItem[] = [];
  const markers: string[] = [];
  const scan: string[] = [];
  for (const it of items) {
    const full = it.parallel ? `[P] ${it.title}` : it.title;
    const [text, overflow] = fit(full, LIMIT.item);
    const lines = it.details.map((d) => d.text);
    checklist.push({ id: it.id, text, requirementIds: requirementsOf([it.title, ...lines]) });
    const detail = normalizeBlock(overflow ? [`- Mô tả: ${full}`, ...lines] : lines);
    if (detail !== "") markers.push(`#### ${it.id}\n${detail}`);
    scan.push(it.title, ...lines);
  }
  return { checklist, markers, scan };
}

// ---- Lexer ------------------------------------------------------------------------------------------------------

function lex(markdown: string, generic: boolean): Doc {
  const lines = markdown
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .split("\n")
    .map((l) => l.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "    ")));
  const root: Node = { level: 0, title: "", key: null, line: 0, parent: null, project: null, deps: [] };
  const doc: Doc = { root, items: [], texts: [], errors: [] };
  let node = root;
  let fence: string | null = null;
  let genericCount = 0;

  for (let i = 0; i < lines.length; ) {
    const raw = lines[i] ?? "";
    const line = i + 1;
    if (fence !== null) {
      doc.texts.push({ line, text: raw, node, heading: false });
      if (raw.trim().startsWith(fence)) fence = null;
      i++;
      continue;
    }
    const f = FENCE.exec(raw);
    if (f) {
      fence = (f[1] ?? "```").slice(0, 3);
      doc.texts.push({ line, text: raw, node, heading: false });
      i++;
      continue;
    }
    const h = HEADING.exec(raw);
    if (h) {
      const level = (h[1] ?? "#").length;
      while (node.level >= level && node.parent) node = node.parent;
      const text = h[2] ?? "";
      const key = EXPLICIT_KEY.exec(text);
      const next: Node = {
        level,
        title: (key ? text.slice(0, key.index) : text).trim(),
        key: key?.[1] ?? null,
        line,
        parent: node,
        project: null,
        deps: [],
      };
      doc.texts.push({ line, text: raw, node: next, heading: true });
      node = next;
      i++;
      continue;
    }
    const task = TASK_LINE.exec(raw);
    const check = !task && generic ? CHECK_LINE.exec(raw) : null;
    if (task || check) {
      const indent = (task?.[1] ?? check?.[1] ?? "").length;
      const id = task ? (task[3] ?? "") : String(++genericCount);
      const rest = task ? (task[4] ?? "") : (check?.[3] ?? "");
      i = readItem(doc, lines, i, indent, id, rest, node);
      continue;
    }
    const project = PROJECT_LINE.exec(raw);
    if (project) {
      const ref = { key: project[1] ?? "", line };
      if (node.project && node.project.key !== ref.key) {
        doc.errors.push({
          line,
          message: `Dòng ${line}: ${nodeLabel(node)} đã ghi dự án ${node.project.key} ở dòng ${node.project.line}.`,
        });
      }
      node.project ??= ref;
      i++;
      continue;
    }
    const dep = DEP_LABEL.exec(raw);
    if (dep) {
      node.deps.push(...refsOf(dep[1] ?? "", line, null));
      const rest = raw.replace(DEP_LABEL, "");
      if (!emptyBullet(rest)) doc.texts.push({ line, text: rest.trimEnd(), node, heading: false });
      i++;
      continue;
    }
    doc.texts.push({ line, text: raw, node, heading: false });
    i++;
  }
  return doc;
}

function readItem(
  doc: Doc,
  lines: readonly string[],
  start: number,
  indent: number,
  id: string,
  rest: string,
  node: Node,
): number {
  const line = start + 1;
  const base = indent + 2;
  let title = rest;
  const raw: { text: string; line: number }[] = [];
  let j = start + 1;
  while (j < lines.length) {
    const l = lines[j] ?? "";
    if (l.trim() === "") {
      let k = j + 1;
      while (k < lines.length && (lines[k] ?? "").trim() === "") k++;
      if (k < lines.length && indentOf(lines[k] ?? "") >= base) {
        for (; j < k; j++) raw.push({ text: "", line: j + 1 });
        continue;
      }
      break;
    }
    if (indentOf(l) < base) break;
    const text = l.slice(base);
    // Dòng thụt vào ngay sau dòng task mà không phải gạch đầu dòng là phần mô tả bị xuống dòng.
    if (raw.length === 0 && !BULLET.test(text)) title += ` ${text.trim()}`;
    else raw.push({ text, line: j + 1 });
    j++;
  }

  const deps: Ref[] = [];
  const takeDeps = (text: string, at: number): string => {
    let out = text.replace(DEP_PAREN, (_m, clause: string) => {
      deps.push(...refsOf(clause, at, id));
      return "";
    });
    const label = DEP_LABEL.exec(out);
    if (label) {
      deps.push(...refsOf(label[1] ?? "", at, id));
      out = out.replace(DEP_LABEL, "");
    }
    return out;
  };
  title = takeDeps(title, line);
  const details: Detail[] = [];
  for (const r of raw) {
    if (r.text === "") {
      details.push({ text: "", check: null });
      continue;
    }
    const text = takeDeps(r.text, r.line).trimEnd();
    if (emptyBullet(text)) continue;
    details.push({ text, check: SUB_CHECK.exec(text)?.[1]?.trim() ?? null });
  }

  let head = title.trim();
  let parallel = false;
  const keep: string[] = [];
  const tags: ProjectRef[] = [];
  for (;;) {
    const m = /^\[([^\]]*)\][ \t]*/.exec(head);
    const tag = m?.[1]?.trim() ?? "";
    if (!m) break;
    if (tag === "P") parallel = true;
    else if (/^US\d+$/i.test(tag)) keep.push(`[${tag}]`);
    else if (/^@[A-Za-z0-9][\w.-]*$/.test(tag)) tags.push({ key: tag.slice(1), line });
    else break;
    head = head.slice(m[0].length);
  }
  // Thẻ dự án có thể nằm giữa mô tả; bỏ qua thẻ trong `code` vì đó là ví dụ, không phải thẻ.
  head = head
    .split(/(`[^`]*`)/)
    .map((part, k) =>
      k % 2 === 1
        ? part
        : part.replace(PROJECT_TAG, (_m, key: string) => {
            tags.push({ key, line });
            return "";
          }),
    )
    .join("");
  doc.items.push({
    id,
    line,
    parallel,
    title: [...keep, head]
      .join(" ")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
    tags,
    details,
    deps,
    node,
  });
  return j;
}

function refsOf(clause: string, line: number, owner: string | null): Ref[] {
  // "spec 009 T022" là task của spec khác: hub không quản phụ thuộc ngoài hạng mục.
  const text = clause.replace(/`[^`]*`/g, " ").replace(/\bspec\s+\d+\s+T\d{3,4}\b/giu, " ");
  const refs: Ref[] = [];
  for (const m of text.matchAll(/\b(T\d{3,4})(?:[ \t]*(?:–|—|-|\.\.)[ \t]*(T\d{3,4}))?\b/g)) {
    const from = m[1] ?? "";
    const to = m[2];
    const a = Number(from.slice(1));
    const b = to ? Number(to.slice(1)) : a;
    if (to && b > a && b - a <= LIMIT.tasks) {
      for (let n = a; n <= b; n++) refs.push({ id: `T${String(n).padStart(from.length - 1, "0")}`, line, owner });
    } else {
      refs.push({ id: from, line, owner });
      if (to) refs.push({ id: to, line, owner });
    }
  }
  return refs;
}

// ---- Ghi --------------------------------------------------------------------------------------------------------

/**
 * Ghi bản tách về Markdown theo định dạng của bộ đọc; đọc–ghi–đọc giữ nguyên cấu trúc. Biết `homeProject` thì task của
 * dự án chính không ghi thẻ dự án; không biết thì ghi thẻ cho mọi task để đọc lại không đổi dự án.
 *
 * Bản tách không giữ tiêu đề tài liệu, trạng thái `[x]` và cách chia phần của độ mịn `item` (bộ ghi giữ thứ tự task
 * dưới một tiêu đề; dự án ghi bằng thẻ).
 */
export function writeBreakdown(breakdown: Breakdown, parser: BreakdownParser, homeProject?: string): string {
  if (!SUPPORTED.includes(parser)) throw new Error(`Bộ ghi “${parser}” chưa có.`);
  const showProject = (key: string) => homeProject === undefined || key !== homeProject;
  const ids = new TaskIds(breakdown.tasks);
  const out =
    breakdown.granularity === "item"
      ? writeItems(breakdown.tasks, parser, ids, showProject)
      : writeSections(breakdown, ids, showProject);
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

function writeItems(
  tasks: readonly BreakdownTask[],
  parser: BreakdownParser,
  ids: TaskIds,
  showProject: (key: string) => boolean,
): string[] {
  // Khoá lát không phải T### (task mới tạo trên màn duyệt) nhận mã mới; phụ thuộc đổi theo.
  const rename = new Map(tasks.map((t) => [t.sliceKey, TASK_ID.test(t.sliceKey) ? t.sliceKey : ids.next()]));
  const named = tasks.map((t) => ({
    ...t,
    sliceKey: rename.get(t.sliceKey) ?? t.sliceKey,
    dependsOn: t.dependsOn.map((d) => rename.get(d) ?? d),
  }));
  const out = ["# Tasks", ""];
  for (const t of named) {
    const deps = t.dependsOn.join(", ");
    const tag = showProject(t.project) ? ` [@${t.project}]` : "";
    const inline = parser === "speckit-tasks" && deps !== "" ? ` (phụ thuộc ${deps})` : "";
    out.push(`- [ ] ${t.sliceKey}${t.parallel ? " [P]" : ""}${tag} ${oneLine(t.title)}${inline}`.trimEnd());
    const body = t.body === "" ? [] : t.body.split("\n");
    if (parser === "hive-tasks") {
      const dep = `**Phụ thuộc**: ${deps || "không"}`;
      const at = body.findIndex((l) => HIVE_LEVEL_LINE.test(l));
      if (at >= 0) body[at] = `- ${dep} · ${(body[at] ?? "").slice(2)}`;
      else body.push(`- ${dep}`);
    }
    out.push(...indent(body), ...t.checklist.map((c) => `  - [ ] ${oneLine(c.text)}`), "");
  }
  return out;
}

function writeSections(breakdown: Breakdown, ids: TaskIds, showProject: (key: string) => boolean): string[] {
  const single = breakdown.granularity === "single";
  const plain = single && breakdown.tasks.every((t) => t.checklist.every((c) => !TASK_ID.test(c.id)));
  const details = new Map<string, string[]>();
  const preambles = new Map<string, string[]>();
  for (const t of breakdown.tasks) {
    const { preamble, blocks } = splitBody(t.body);
    preambles.set(t.sliceKey, preamble);
    for (const [id, lines] of blocks) details.set(id, lines);
  }
  // Mục không có mã T### (thêm trên màn duyệt) nhận mã mới; phần rỗng có một mục để phần không biến mất khi đọc lại.
  const items = new Map(
    breakdown.tasks.map((t) => {
      const list = t.checklist.map((c) => ({
        id: plain || TASK_ID.test(c.id) ? c.id : ids.next(),
        text: c.text,
        detail: details.get(c.id) ?? [],
      }));
      if (list.length === 0 && !single) list.push({ id: ids.next(), text: t.title, detail: [] });
      return [t.sliceKey, list] as const;
    }),
  );
  const firstId = (key: string) => items.get(key)?.[0]?.id ?? key;

  const out = single ? [] : ["# Tasks", ""];
  for (const t of breakdown.tasks) {
    const title = oneLine(t.title);
    if (single) out.push(`# ${title}`, "");
    else out.push(`## ${title}${slug(title) === t.sliceKey ? "" : ` {#${t.sliceKey}}`}`, "");
    if (showProject(t.project)) out.push(`Dự án: ${t.project}`);
    if (!single && t.dependsOn.length > 0) out.push(`**Phụ thuộc**: ${t.dependsOn.map(firstId).join(", ")}`);
    const preamble = preambles.get(t.sliceKey) ?? [];
    out.push("", ...(single ? preamble : demote(preamble)), "");
    for (const it of items.get(t.sliceKey) ?? []) {
      out.push(plain ? `- [ ] ${oneLine(it.text)}` : `- [ ] ${it.id} ${oneLine(it.text)}`, ...indent(it.detail));
    }
    out.push("");
  }
  return out;
}

function splitBody(body: string): { preamble: string[]; blocks: Map<string, string[]> } {
  const lines = body === "" ? [] : body.split("\n");
  const preamble: string[] = [];
  const blocks = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const l of lines) {
    const m = DETAIL_MARK.exec(l);
    if (m) {
      current = [];
      blocks.set(m[1] ?? "", current);
    } else (current ?? preamble).push(l);
  }
  for (const [id, block] of blocks) {
    const text = normalizeBlock(block);
    blocks.set(id, text === "" ? [] : text.split("\n"));
  }
  return { preamble, blocks };
}

/** Mã T### tiếp theo chưa dùng trong bản tách. */
class TaskIds {
  private n: number;
  private readonly width: number;
  constructor(tasks: readonly BreakdownTask[]) {
    const all = tasks.flatMap((t) => [t.sliceKey, ...t.checklist.map((c) => c.id)]).filter((k) => TASK_ID.test(k));
    this.n = Math.max(0, ...all.map((k) => Number(k.slice(1))));
    this.width = Math.max(3, ...all.map((k) => k.length - 1));
  }
  next(): string {
    this.n++;
    return `T${String(this.n).padStart(this.width, "0")}`;
  }
}

// ---- Đồ thị, độ phủ ---------------------------------------------------------------------------------------------

/**
 * Đợt theo thứ tự topo: đợt k gồm task có mọi phụ thuộc ở đợt trước, giữ thứ tự tài liệu trong đợt. Phụ thuộc trỏ
 * tới khoá không có bị bỏ qua. Có vòng thì `cycle` là một vòng tìm được, task trong và sau vòng không vào đợt nào.
 */
export function breakdownWaves(tasks: readonly Pick<BreakdownTask, "sliceKey" | "dependsOn">[]): {
  waves: string[][];
  cycle: string[] | null;
} {
  const keys = new Set(tasks.map((t) => t.sliceKey));
  const deps = new Map(tasks.map((t) => [t.sliceKey, t.dependsOn.filter((d) => keys.has(d) && d !== t.sliceKey)]));
  const done = new Set<string>();
  const waves: string[][] = [];
  for (;;) {
    const wave = tasks
      .map((t) => t.sliceKey)
      .filter((k) => !done.has(k) && (deps.get(k) ?? []).every((d) => done.has(d)));
    if (wave.length === 0) break;
    for (const k of wave) done.add(k);
    waves.push(unique(wave));
  }
  const left = tasks.map((t) => t.sliceKey).filter((k) => !done.has(k));
  if (left.length === 0) return { waves, cycle: null };
  // Mọi task còn lại đều có phụ thuộc còn lại, nên đi theo phụ thuộc chưa xong chắc chắn gặp lại một đỉnh.
  const path: string[] = [];
  let at = left[0] ?? "";
  while (!path.includes(at)) {
    path.push(at);
    at = (deps.get(at) ?? []).find((d) => !done.has(d)) ?? at;
  }
  return { waves, cycle: path.slice(path.indexOf(at)) };
}

/** Độ phủ requirement của bản tách, tổng và theo dự án. */
export function coverage(requirements: readonly string[], breakdown: Breakdown): BreakdownCoverage {
  const reqs = unique(requirements);
  const covered = new Set<string>();
  const byProject = new Map<string, Set<string>>();
  for (const t of breakdown.tasks) {
    const set = byProject.get(t.project) ?? new Set<string>();
    byProject.set(t.project, set);
    for (const r of [...t.requirementIds, ...t.checklist.flatMap((c) => c.requirementIds)]) {
      covered.add(r);
      set.add(r);
    }
  }
  return {
    total: { requirements: reqs.length, planned: reqs.filter((r) => covered.has(r)).length },
    byProject: [...byProject].map(([project, set]) => ({
      project,
      requirements: reqs.length,
      planned: reqs.filter((r) => set.has(r)).length,
    })),
    missing: reqs.filter((r) => !covered.has(r)),
  };
}

/**
 * Mã requirement trong văn bản theo regex của chế độ (D18), không trùng, theo thứ tự xuất hiện. Mã phải đứng riêng:
 * `R-\d+` không bắt `FR-001`. Trả null khi regex không hợp lệ.
 */
export function findRequirements(markdown: string, pattern: string): string[] | null {
  return requirementScanner(pattern)?.([markdown]) ?? null;
}

function requirementScanner(pattern: string): ((texts: readonly string[]) => string[]) | null {
  let re: RegExp;
  try {
    re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, "gu");
  } catch {
    try {
      re = new RegExp(`(?<![A-Za-z0-9_])(?:${pattern})(?![A-Za-z0-9_])`, "g");
    } catch {
      return null;
    }
  }
  return (texts) => unique(texts.flatMap((t) => [...t.matchAll(re)].map((m) => m[0]).filter((m) => m !== "")));
}

// ---- Tiện ích ---------------------------------------------------------------------------------------------------

/** Đường dẫn file nêu trong task (FR-058): trong `code` có `/` hoặc đuôi file quen, ngoài `code` phải có cả hai. */
function filesOf(texts: readonly string[]): string[] {
  const out: string[] = [];
  const add = (raw: string, strict: boolean) => {
    for (const p of expandBraces(raw)) {
      const path = p.replace(/^\.\//, "").replace(/[.,;:)]+$/, "");
      if (path === "" || path.startsWith("/") || /^[a-z][\w+.-]*:/i.test(path) || path.length > 300) continue;
      if (!/^[\w@.*{}/-]+$/.test(path)) continue;
      const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
      const known = ext !== undefined && KNOWN_EXT.has(ext);
      const slash = path.includes("/");
      if (strict ? slash && known : slash || known) out.push(path);
    }
  };
  for (const text of texts) {
    for (const m of text.matchAll(/`([^`\s]+)`/g)) add(m[1] ?? "", false);
    const bare = text.replace(/`[^`]*`/g, " ");
    for (const m of bare.matchAll(/(?<![\p{L}\p{N}_./@:-])((?:\.{1,2}\/)?(?:[\w@.-]+\/)+[\w.*-]+)/gu)) {
      add(m[1] ?? "", true);
    }
  }
  return unique(out).slice(0, LIMIT.files);
}

function expandBraces(s: string, budget = { n: LIMIT.files }): string[] {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(s);
  if (!m || budget.n <= 0) return [s];
  return (m[1] ?? "").split(",").flatMap((part) => {
    budget.n--;
    return expandBraces(s.slice(0, m.index) + part.trim() + s.slice(m.index + m[0].length), budget);
  });
}

/** Bỏ dấu tiếng Việt, chữ thường, gạch nối: khoá lát của phần khi tiêu đề không ghi `{#khoá}`. */
function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

/** Gộp dòng trống liền nhau, bỏ dòng trống và `---` ở hai đầu: body đọc lại sau khi ghi không đổi. */
function normalizeBlock(lines: readonly string[]): string {
  const out: string[] = [];
  for (const l of lines.map((x) => x.trimEnd())) {
    if (l === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(l);
  }
  const rule = (l: string | undefined) => l === "" || (l !== undefined && /^(?:-{3,}|\*{3,}|_{3,})$/.test(l));
  while (out.length > 0 && rule(out[0])) out.shift();
  while (out.length > 0 && rule(out[out.length - 1])) out.pop();
  return out.join("\n");
}

/** Tiêu đề trong body phải sâu hơn tiêu đề phần (`##`), nếu không bộ đọc coi nó là phần mới. */
function demote(lines: readonly string[]): string[] {
  let fence = false;
  return lines.map((l) => {
    if (FENCE.test(l)) fence = !fence;
    const h = fence ? null : /^(#{1,2})([ \t].*)$/.exec(l);
    return h ? `###${h[2]}` : l;
  });
}

function indent(lines: readonly string[]): string[] {
  return lines.map((l) => (l === "" ? "" : `  ${l}`));
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function indentOf(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}

function emptyBullet(text: string): boolean {
  return /^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*$/.test(text);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Cắt chữ dài; trả kèm cờ để chữ đầy đủ được giữ trong body ("- Mô tả: …"). */
function fit(text: string, max: number): [string, boolean] {
  return text.length <= max ? [text, false] : [clip(text, max), true];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function chain(node: Node): Node[] {
  const out: Node[] = [];
  for (let n: Node | null = node; n && n.level > 0; n = n.parent) out.push(n);
  return out;
}

function effectiveProject(it: Item): ProjectRef | null {
  return it.tags[0] ?? chain(it.node).find((n) => n.project)?.project ?? null;
}

function allNodes(doc: Doc): Node[] {
  const seen = new Set<Node>([doc.root]);
  for (const t of doc.texts) for (const n of chain(t.node)) seen.add(n);
  for (const it of doc.items) for (const n of chain(it.node)) seen.add(n);
  return [...seen];
}

function descendants(doc: Doc, section: Node, sectionOf: (n: Node) => Node): Node[] {
  return allNodes(doc).filter((n) => n !== section && n.level > section.level && sectionOf(n) === section);
}

function firstNode(doc: Doc, level: number | null): Node | null {
  return doc.texts.find((t) => t.heading && (level === null || t.node.level === level))?.node ?? null;
}

function nodeOfRef(ref: Ref, nodes: ReadonlySet<Node>): Node | null {
  for (const n of nodes) if (n.deps.includes(ref)) return n;
  return null;
}

function nodeLabel(node: Node | null): string {
  return node && node.level > 0 ? `phần “${node.title}”` : "tài liệu";
}

function lineOf(tasks: readonly BreakdownTask[], key: string): number {
  return tasks.find((t) => t.sliceKey === key)?.line ?? 0;
}

function taskLabel(tasks: readonly BreakdownTask[], key: string, granularity: string): string {
  const t = tasks.find((x) => x.sliceKey === key);
  return granularity === "item" || !t ? key : `“${t.title}”`;
}
