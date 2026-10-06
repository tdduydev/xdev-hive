import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { AGENT_TEMPLATES, OPEN_POLICY, type ModelSelection } from "@xdev-hive/core";
import { agyModels, codexModels, nearestModel, ProfileModels, unsupportedModel } from "#desktop/main/runner/models.ts";
import { applyPolicy, ranOn, routeProfile, withoutModel } from "#desktop/main/runner/command.ts";

it("discovers only listed Codex slugs in the profile's CODEX_HOME and refreshes changed caches", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "hive-models-"));
  try {
    const p = { ...AGENT_TEMPLATES.codex, env: { CODEX_HOME: home } };
    const models = new ProfileModels();
    assert.equal(models.snapshot(p, {}), null);
    writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-sol", visibility: "list" }, { slug: "gpt-6.1-sol", visibility: "hide" }, { slug: "invalid" }] }));
    assert.deepEqual(models.snapshot(p, {}), ["gpt-6-sol"]);
    writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol", visibility: "list" }] }));
    assert.deepEqual(models.snapshot(p, {}), ["gpt-6.1-sol"]);
    assert.equal(models.snapshot({ ...p, env: { CODEX_HOME: path.join(home, "other") } }, {}), null);
    assert.equal(codexModels("broken"), null);
    assert.deepEqual(codexModels('{"models":[]}'), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("discovers Claude aliases and probes agy models once per profile", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-agy-models-"));
  try {
    const cli = path.join(dir, "agy");
    writeFileSync(cli, '#!/bin/sh\n[ "$1" = models ] || exit 1\nprintf \'%s\' "$MODEL_LIST"\n', { mode: 0o755 });
    const p = { ...AGENT_TEMPLATES.antigravity, bin: cli, env: { MODEL_LIST: '["gemini-3.7-pro"]' } };
    const models = new ProfileModels();
    await models.refresh(p, {});
    assert.deepEqual(models.snapshot(p, {}), ["gemini-3.7-pro"]);
    const other = { ...p, env: { MODEL_LIST: "unknown command models" } };
    await models.refresh(other, {});
    assert.equal(models.snapshot(other, {}), null);
    assert.ok(models.snapshot(AGENT_TEMPLATES.claude, {})?.includes("sonnet"));
    assert.deepEqual(agyModels('{"models":[{"id":"gemini-3.8-pro"},{"id":"hidden", "available":false}]}'), ["gemini-3.8-pro"]);
    assert.deepEqual(agyModels('Available models:\n gemini-3.8-pro  Pro\n gemini-3.8-flash  Flash'), ["gemini-3.8-pro", "gemini-3.8-flash"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("routes to a supported same-family model, or CLI default without router effort", () => {
  const selection: ModelSelection = { tier: "standard", reason: "feature/m", models: { codex: { model: "gpt-6.1-sol", effort: "low" } } };
  const p = AGENT_TEMPLATES.codex;
  const route = (models: string[] | null) => routeProfile(p, p, OPEN_POLICY, selection, models);
  assert.equal(ranOn(route(["gpt-6-sol", "gpt-5.6-sol", "gpt-6-astra"]).profile).model, "gpt-6-sol");
  assert.match(route(["gpt-6-sol"]).note!, /not supported/);
  assert.doesNotMatch(route(["gpt-6-sol"]).note!, /not allowed/);
  assert.deepEqual(ranOn(route(["gpt-6-astra"]).profile), { model: null, effort: null });
  assert.match(route(null).note!, /support unknown/);
  assert.equal(nearestModel("gemini-3.8-pro", ["gemini-3.7-pro", "gemini-3.8-flash"]), "gemini-3.7-pro");
  assert.equal(nearestModel("unknown-model", ["gpt-6-sol"]), null);
  const pinned = { ...p, args: [...p.args, "-m", "user-pin"] };
  assert.equal(ranOn(routeProfile(pinned, pinned, OPEN_POLICY, selection, []).profile).model, "user-pin");
  assert.deepEqual(routeProfile(p, p, OPEN_POLICY, null, []).profile, p);
  const policy = { ...OPEN_POLICY, models: { codex: ["gpt-6-astra"] } };
  assert.throws(() => routeProfile(p, applyPolicy(p, policy).profile, policy, selection, ["gpt-6-sol"]), /No supported model allowed/);
});

it("recognises model rejection and removes model-specific flags for recovery", () => {
  for (const text of ["The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", "unknown model: sonnet", "model gemini-3.8-pro not found"]) assert.equal(unsupportedModel(text), true);
  assert.equal(unsupportedModel("rate limit exceeded"), false);
  const p = withoutModel({ ...AGENT_TEMPLATES.codex, args: ["exec", "--model=x", "-m", "y", "-c", 'model="z"', "--config=model_reasoning_effort=high", "-c", "sandbox_mode=read-only", "--effort", "high", "{prompt}"] });
  assert.deepEqual(p.args, ["exec", "-c", "sandbox_mode=read-only", "{prompt}"]);
});

it("preserves capabilities in hub heartbeat storage, including unknown older profiles", async () => {
  const { SqliteHive } = await import("@xdev-hive/core/node");
  const hive = new SqliteHive(":memory:");
  const actor = { name: "test", role: "admin" as const };
  const base = { label: "test", kind: "codex", enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0 };
  await hive.call("machines.heartbeat", { machine: "test", instance: "12345678", runs: [], profiles: [
    { ...base, id: "new", supportedModels: ["gpt-6-sol"] },
    { ...base, id: "unknown", supportedModels: null },
    { ...base, id: "old" },
  ] }, actor);
  const [machine] = await hive.call("machines.list", {}, actor);
  assert.deepEqual(machine!.profiles.map((p) => p.supportedModels), [["gpt-6-sol"], null, undefined]);
  hive.close();
});
