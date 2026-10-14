import { type Breakdown, type BreakdownTask, breakdownWaves } from "@xdev-hive/contracts";

/** Kết quả một thao tác sửa: bản mới, hoặc lỗi để màn báo mà không đổi gì (vd. chu trình). */
export type EditResult = { ok: true; breakdown: Breakdown } | { ok: false; cycle: string[] };

const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];

/** Tính lại đợt sau mỗi lần sửa: hub cũng tính lại khi lưu, nhưng người duyệt cần thấy đợt ngay. */
function withWaves(b: Breakdown, tasks: BreakdownTask[]): EditResult {
  const { waves, cycle } = breakdownWaves(tasks);
  if (cycle) return { ok: false, cycle };
  return { ok: true, breakdown: { ...b, tasks, waves } };
}

/** Thay `from` bằng `to` trong phụ thuộc của mọi task, bỏ phụ thuộc vào chính mình. */
function rewire(tasks: BreakdownTask[], from: string, to: string): BreakdownTask[] {
  return tasks.map((t) => ({
    ...t,
    dependsOn: uniq(t.dependsOn.map((d) => (d === from ? to : d))).filter((d) => d !== t.sliceKey),
  }));
}

/** Gộp `from` vào `into`: nội dung, checklist, requirement, file và phụ thuộc cộng lại; ai chờ `from` thì chờ `into`. */
export function mergeTasks(b: Breakdown, from: string, into: string): EditResult {
  const src = b.tasks.find((t) => t.sliceKey === from);
  if (!src || from === into) return { ok: true, breakdown: b };
  const tasks = b.tasks
    .filter((t) => t.sliceKey !== from)
    .map((t) =>
      t.sliceKey === into
        ? {
            ...t,
            body: [t.body, `### ${src.title}`, src.body].filter(Boolean).join("\n\n"),
            requirementIds: uniq([...t.requirementIds, ...src.requirementIds]),
            checklist: [...t.checklist, ...src.checklist],
            files: uniq([...t.files, ...src.files]),
            dependsOn: uniq([...t.dependsOn, ...src.dependsOn]),
            parallel: t.parallel && src.parallel,
          }
        : t,
    );
  return withWaves(b, rewire(tasks, from, into));
}

/** Khoá lát mới không trùng: `T003-2`, `T003-3`… */
function freshKey(b: Breakdown, base: string): string {
  const keys = new Set(b.tasks.map((t) => t.sliceKey));
  for (let i = 2; ; i++) if (!keys.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * Tách nửa sau checklist thành task mới cùng dự án, chạy sau task gốc (cần hai mục trở lên). Task mới giữ phụ thuộc của
 * task gốc để không chạy sớm hơn.
 */
export function splitTask(b: Breakdown, key: string): EditResult {
  const at = b.tasks.findIndex((t) => t.sliceKey === key);
  const src = b.tasks[at];
  if (!src || src.checklist.length < 2) return { ok: true, breakdown: b };
  const half = Math.ceil(src.checklist.length / 2);
  const moved = src.checklist.slice(half);
  const next: BreakdownTask = {
    ...src,
    sliceKey: freshKey(b, key),
    title: `${src.title} (2)`,
    body: "",
    checklist: moved,
    requirementIds: uniq(moved.flatMap((c) => c.requirementIds)),
    dependsOn: [key],
  };
  const tasks = [...b.tasks];
  tasks.splice(at, 1, { ...src, checklist: src.checklist.slice(0, half) }, next);
  return withWaves(b, tasks);
}

/** Biến task thành một mục checklist của `into` (FR-024: việc quá nhỏ cho một run). */
export function toChecklist(b: Breakdown, key: string, into: string): EditResult {
  const src = b.tasks.find((t) => t.sliceKey === key);
  if (!src || key === into) return { ok: true, breakdown: b };
  const item = { id: key, text: src.title, requirementIds: src.requirementIds };
  const tasks = b.tasks
    .filter((t) => t.sliceKey !== key)
    .map((t) =>
      t.sliceKey === into
        ? { ...t, checklist: [...t.checklist, item], dependsOn: uniq([...t.dependsOn, ...src.dependsOn]) }
        : t,
    );
  return withWaves(b, rewire(tasks, key, into));
}

export function setProject(b: Breakdown, key: string, project: string): EditResult {
  return withWaves(
    b,
    b.tasks.map((t) => (t.sliceKey === key ? { ...t, project } : t)),
  );
}

/** Thêm phụ thuộc; tạo chu trình thì trả lỗi kèm vòng để màn chỉ rõ task nào. */
export function addDependency(b: Breakdown, key: string, dep: string): EditResult {
  if (key === dep) return { ok: false, cycle: [key] };
  return withWaves(
    b,
    b.tasks.map((t) => (t.sliceKey === key ? { ...t, dependsOn: uniq([...t.dependsOn, dep]) } : t)),
  );
}

export function removeDependency(b: Breakdown, key: string, dep: string): EditResult {
  return withWaves(
    b,
    b.tasks.map((t) => (t.sliceKey === key ? { ...t, dependsOn: t.dependsOn.filter((d) => d !== dep) } : t)),
  );
}

/** Đợt (0-based) của từng task theo `waves` đã tính. */
export function waveOf(b: Breakdown): Map<string, number> {
  return new Map(b.waves.flatMap((wave, i) => wave.map((k) => [k, i] as const)));
}
