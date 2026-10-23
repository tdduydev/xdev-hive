import { createHash } from "node:crypto";
import type { ConfigLayer, EffectiveSetting } from "@xdev-hive/contracts";
import { type CeilingDef, type CeilingRule, layerIndex, REGISTRY, type SettingDef } from "./registry.ts";

/** Giá trị của một tầng. Khoá vắng mặt là "chưa đặt"; `locks` là khoá đã khoá với các tầng dưới. */
export type LayerInput = {
  layer: ConfigLayer;
  targetId: string | null;
  values: Readonly<Record<string, unknown>>;
  locks?: readonly string[];
};

type Candidate = { layer: ConfigLayer; targetId: string | null; value: unknown; locked: boolean; valid: boolean };

/** Rank nhỏ là chặt. Vô cực là "không giới hạn", không bao giờ thắng. */
function rankOf(rule: CeilingRule, value: unknown): number {
  if (rule === "restrictive-true") return value === true ? 0 : 1;
  if (rule === "restrictive-false") return value === false ? 0 : 1;
  if (rule === "min-number") return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
  return rule.scale.indexOf(value as string);
}

function candidatesOf(def: SettingDef, layers: readonly LayerInput[]): Candidate[] {
  const out: Candidate[] = [];
  for (const l of layers) {
    const locked = l.locks?.includes(def.key) ?? false;
    // Tầng chỉ khoá, chưa đặt giá trị, vẫn phải hiện để khoá có tác dụng với các tầng dưới.
    if (!def.layers.includes(l.layer) || !(def.key in l.values || locked)) continue;
    const value = l.values[def.key];
    // Giá trị hỏng (sửa tay trong DB) bị bỏ qua thay vì làm cả cấu hình hỏng.
    out.push({
      layer: l.layer,
      targetId: l.targetId,
      value,
      locked,
      valid: def.key in l.values && def.schema.safeParse(value).success,
    });
  }
  return out;
}

const ref = (c: Candidate | undefined) => (c ? { layer: c.layer, targetId: c.targetId } : null);

function resolveCeiling(def: CeilingDef, cands: Candidate[]): Omit<EffectiveSetting, "key"> {
  const usable = cands.filter((c) => c.valid && rankOf(def.rule, c.value) !== Number.POSITIVE_INFINITY);
  let best: Candidate | undefined;
  for (const c of usable) {
    if (!best || rankOf(def.rule, c.value) < rankOf(def.rule, best.value)) best = c;
  }
  const bestRank = best ? rankOf(def.rule, best.value) : 0;
  // Chỉ tầng nằm dưới tầng quyết định mới "vượt trần"; tầng ngoài đặt lỏng hơn thì đã là trần rộng hơn, không phải lỗi.
  const over = best
    ? usable.find((c) => layerIndex(c.layer) > layerIndex(best.layer) && rankOf(def.rule, c.value) > bestRank)
    : undefined;
  return {
    value: best ? best.value : def.default,
    source: ref(best),
    lock: null,
    overCeiling: over ? { layer: over.layer, targetId: over.targetId, value: over.value } : null,
    chain: cands.map((c) => ({
      layer: c.layer,
      targetId: c.targetId,
      value: c.value,
      locked: c.locked,
      applied: c === best,
    })),
  };
}

/** Tầng khoá ngoài cùng; các tầng sâu hơn nó không được đặt giá trị. */
function lockOf(cands: Candidate[]): Candidate | undefined {
  return cands.find((c) => c.locked);
}

function resolveOverride(def: SettingDef, cands: Candidate[]): Omit<EffectiveSetting, "key"> {
  const lock = lockOf(cands);
  const counted = cands.filter((c) => c.valid && (!lock || layerIndex(c.layer) <= layerIndex(lock.layer)));
  const winner = counted.at(-1);
  return {
    value: winner ? winner.value : def.default,
    source: ref(winner),
    lock: lock ? { layer: lock.layer } : null,
    overCeiling: null,
    chain: cands.map((c) => ({
      layer: c.layer,
      targetId: c.targetId,
      value: c.value,
      locked: c.locked,
      applied: c === winner,
    })),
  };
}

function resolveAdditive(def: SettingDef & { kind: "additive" }, cands: Candidate[]): Omit<EffectiveSetting, "key"> {
  const lock = lockOf(cands);
  const counted = cands.filter((c) => c.valid && (!lock || layerIndex(c.layer) <= layerIndex(lock.layer)));
  const seen = new Set<string>();
  const merged: unknown[] = [];
  // Tầng ngoài đi trước: mục cùng danh tính ở tầng trong không ghi đè được mục của tầng ngoài.
  for (const c of counted) {
    for (const item of c.value as unknown[]) {
      const id = def.identity(item);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(item);
    }
  }
  return {
    value: counted.length > 0 ? merged : def.default,
    source: ref(counted.at(-1)),
    lock: lock ? { layer: lock.layer } : null,
    overCeiling: null,
    chain: cands.map((c) => ({
      layer: c.layer,
      targetId: c.targetId,
      value: c.value,
      locked: c.locked,
      applied: counted.includes(c),
    })),
  };
}

/**
 * Gộp các tầng thành giá trị hiệu lực (FR-010..016). Hàm thuần: không đọc DB, không đọc đồng hồ, nên kết quả chỉ phụ
 * thuộc đầu vào và test được từng trường hợp. Thứ tự của `layers` không quan trọng, engine tự xếp ngoài vào trong.
 */
export function resolveConfig(
  layers: readonly LayerInput[],
  registry: readonly SettingDef[] = REGISTRY,
): EffectiveSetting[] {
  const ordered = [...layers].sort((a, b) => layerIndex(a.layer) - layerIndex(b.layer));
  const results = new Map<string, Omit<EffectiveSetting, "key">>();
  // Trần gộp trước vì `narrow` của cài đặt khác đọc giá trị của chúng.
  const rank = { ceiling: 0, override: 1, additive: 2 } as const;
  for (const def of [...registry].sort((a, b) => rank[a.kind] - rank[b.kind])) {
    const cands = candidatesOf(def, ordered);
    let r: Omit<EffectiveSetting, "key">;
    if (def.kind === "ceiling") r = resolveCeiling(def, cands);
    else if (def.kind === "override") {
      r = resolveOverride(def, cands);
      const narrowed = def.narrow?.(r.value, new Map([...results].map(([k, v]) => [k, v.value])));
      if (def.narrow && narrowed !== r.value) {
        r = {
          ...r,
          overCeiling: { layer: r.source?.layer ?? "instance", targetId: r.source?.targetId ?? null, value: r.value },
          value: narrowed,
        };
      }
    } else r = resolveAdditive(def, cands);
    results.set(def.key, r);
  }
  return registry.map((d) => ({ key: d.key, ...(results.get(d.key) as Omit<EffectiveSetting, "key">) }));
}

/** JSON có khoá xếp thứ tự, để cùng nội dung luôn ra cùng một chuỗi. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Băm giá trị hiệu lực của một công ty. Có `orgId` để hai công ty cùng nội dung vẫn ra hai mã khác nhau, client giữ
 * bộ đệm theo từng công ty không bao giờ nhầm (FR-069). Không băm nguồn và chuỗi tầng: đổi nguồn mà giá trị không đổi
 * thì client không cần tải lại.
 */
export function configVersion(orgId: string, settings: readonly EffectiveSetting[]): string {
  const body = settings.map((s) => [s.key, s.value] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return createHash("sha256")
    .update(canonicalJson({ orgId, settings: body }))
    .digest("hex");
}

/** Bỏ `chain` trước khi gửi cho người không có quyền sửa cấu hình (FR-044). */
export const withoutChain = (s: EffectiveSetting): EffectiveSetting => {
  const { chain: _c, ...rest } = s;
  return rest;
};
