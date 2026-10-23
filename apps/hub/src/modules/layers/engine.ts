import { createHash } from "node:crypto";
import type { ConfigLayer, EffectiveSetting } from "@xdev-hive/contracts";
import { REGISTRY } from "./registry.ts";

export type LayerInput = {
  layer: ConfigLayer;
  targetId: string;
  values: Readonly<Record<string, unknown>>;
  locks?: readonly string[];
};

export function resolveConfig(layers: readonly LayerInput[]): EffectiveSetting[] {
  const ordered = ["org", "project"].flatMap((layer) => layers.filter((l) => l.layer === layer));
  return REGISTRY.map((def) => {
    const result: EffectiveSetting = { key: def.key, value: def.default, source: null, locked: false, chain: [] };
    for (const layer of ordered) {
      const hasValue = Object.hasOwn(layer.values, def.key) && def.schema.safeParse(layer.values[def.key]).success;
      const locks = layer.layer === "org" && !!layer.locks?.includes(def.key);
      if (!hasValue && !locks) continue;
      const applied = !result.locked;
      if (hasValue && applied) {
        result.value = layer.values[def.key];
        result.source = { layer: layer.layer, targetId: layer.targetId };
      }
      result.chain.push({
        layer: layer.layer,
        targetId: layer.targetId,
        value: hasValue ? layer.values[def.key] : result.value,
        locked: locks,
        applied,
      });
      if (locks) result.locked = true;
    }
    return result;
  });
}

export function configVersion(orgId: string, settings: readonly EffectiveSetting[]): string {
  return createHash("sha256").update(JSON.stringify({ orgId, settings })).digest("hex");
}
