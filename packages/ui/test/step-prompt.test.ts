import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { may, PROMPT_LAYERS, PROMPT_ROLES, STEP_PROMPT_MAX, type Me } from "@xdev-hive/core";
import { hasKey, translate } from "#ui/i18n/translate.ts";
import type { MessageKey } from "#ui/i18n/index.tsx";

// Roadmap 72i: the Prompt tab of a gate's panel (the rest of it is covered by the web e2e's pipeline-prompt step).

const account = (projects: NonNullable<Me["access"]>["projects"]): Me => ({ name: "person", role: "member", mode: "hub", access: { projects } });

describe("step prompt tab", () => {
  it("is written by whoever may change what agents read, and read by anyone who sees the project", () => {
    assert.equal(may(account({ app: "manage" }), "app", "contextEdit"), true);
    assert.equal(may(account({ app: "contribute" }), "app", "contextEdit"), false);
    assert.equal(may(account({ app: "contribute" }), "app", "view"), true);
    assert.equal(may(account({ app: { permissions: ["view", "projectSettings"] } }), "app", "contextEdit"), false, "settings are not context");
  });
  it("has its words in both languages, with the same placeholders", () => {
    for (const key of ["hint", "label", "placeholder", "count", "version", "none", "updated", "history", "historyEmpty", "view", "viewing", "load", "close", "cleared", "readOnly", "saved", "promptTab", "roles", "intro", "custom", "locked", "stepsLabel", "saveBy", "insertVar", "notWired", "noStepPrompt", "final", "finalMeta", "sampleTask", "skipped", "repoSample", "adminSample", "taskEmpty", "noneLayer", "role.implement.label", "role.judge.hint", "layer.frame.label", "layer.step.hint", "layer.steer.short"]) {
      const k = `stepPrompt.${key}` as MessageKey;
      assert.ok(hasKey(k), k);
      // en falls back to vi when it lacks a key: the same words in both mean the English one is missing ("Prompt" and "{by} · {at}" are the same in both).
      if (!["promptTab", "updated", "role.implement.label"].includes(key)) assert.notEqual(translate(k, { step: "x", version: 1, used: 1, max: 1, by: "x", at: "x", chars: 1, layers: 1, why: "x", layer: "x" }, "en"), translate(k, { step: "x", version: 1, used: 1, max: 1, by: "x", at: "x", chars: 1, layers: 1, why: "x", layer: "x" }, "vi"), `en ${k}`);
    }
    // The layers the tab lists are the runner's, no more and no fewer.
    for (const id of PROMPT_LAYERS) for (const part of ["label", "hint", "short"]) assert.ok(hasKey(`stepPrompt.layer.${id}.${part}` as MessageKey), `${id}.${part}`);
    for (const r of PROMPT_ROLES) for (const part of ["label", "hint"]) assert.ok(hasKey(`stepPrompt.role.${r.role}.${part}` as MessageKey), `${r.role}.${part}`);
    for (const locale of ["vi", "en"] as const) {
      assert.match(translate("stepPrompt.count", { used: 12, max: STEP_PROMPT_MAX }, locale), new RegExp(`12.*${STEP_PROMPT_MAX}`));
      assert.match(translate("errors.promptVersionConflict", { step: "review", version: 3 }, locale), /review.*3|3.*review/);
    }
  });
});
