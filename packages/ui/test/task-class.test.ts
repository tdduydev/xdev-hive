import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TASK_KINDS, TASK_RISKS, TASK_SIZES } from "@xdev-hive/core";
import { CLASS_FIELDS, CLASS_VALUES, classInput, classSource } from "#ui/lib/task-class.ts";
import { en } from "#ui/i18n/locales/en.ts";
import { vi } from "#ui/i18n/locales/vi.ts";

// Roadmap 54b: the Kind / Size / Risk fields of the task sheet.
describe("task class fields", () => {
  it("changes one field at a time and refuses a value that is not the field's", () => {
    assert.deepEqual(classInput("T-1", "kind", "debug"), { id: "T-1", kind: "debug" });
    assert.deepEqual(classInput("T-1", "size", "l"), { id: "T-1", size: "l" });
    assert.deepEqual(classInput("T-1", "risk", "high"), { id: "T-1", risk: "high" });
    assert.throws(() => classInput("T-1", "size", "debug"));
    assert.throws(() => classInput("T-1", "kind", ""));
  });

  it("says who classified it, and nothing for a task nobody did or an older hub", () => {
    const at = "2026-10-06T08:00:00.000Z";
    assert.deepEqual(classSource({ classifiedBy: "rule", classifiedAt: at }), { by: "rule", name: "rule", at });
    assert.deepEqual(classSource({ classifiedBy: "ai", classifiedAt: at }), { by: "ai", name: "ai", at });
    assert.deepEqual(classSource({ classifiedBy: "duy", classifiedAt: at }), { by: "person", name: "duy", at });
    assert.equal(classSource({ classifiedBy: null, classifiedAt: null }), null);
    assert.equal(classSource({} as never), null);
  });

  it("has a label for every value, in Vietnamese and English", () => {
    assert.deepEqual(CLASS_FIELDS, ["kind", "size", "risk"]);
    assert.deepEqual([CLASS_VALUES.kind, CLASS_VALUES.size, CLASS_VALUES.risk], [TASK_KINDS, TASK_SIZES, TASK_RISKS]);
    for (const catalog of [vi, en]) {
      for (const field of CLASS_FIELDS) {
        const labels = catalog.taskClass[`${field}Values`] as Record<string, string>;
        assert.deepEqual(Object.keys(labels).sort(), [...CLASS_VALUES[field]].sort(), field);
      }
    }
  });
});
