import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { agentProfileSchema } from "@xdev-hive/core";
import { saveConfig } from "@xdev-hive/core/node";
import { readDesktopConfig } from "#desktop/main/config-read.ts";

const profile = (id: string, over: Record<string, unknown> = {}) => ({ id, label: id, kind: "claude", bin: "claude", args: [], ...over });
const write = (body: unknown) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "hive-config-read-")), "config.json");
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
};

// BUG-config-silent (6/10): six profiles with "account": null on .52 failed the whole file; the app logged "start" and
// then sat with no heartbeat and nothing in main.log for four hours.
describe("config.json as the app reads it", () => {
  it("reads \"account\": null as no account, with nothing to report", () => {
    const lines: string[] = [];
    const file = write({ mode: "hub", hub: { url: "https://hive.test", token: "t" }, agents: [profile("claude-1", { account: null }), profile("claude-2", { account: "max-duy" })] });
    const { config, issues } = readDesktopConfig(file, (l) => lines.push(l));
    assert.deepEqual(issues, []);
    assert.deepEqual(lines, []);
    assert.equal(config?.mode, "hub");
    assert.deepEqual(config?.agents.map((a) => [a.id, a.account]), [["claude-1", undefined], ["claude-2", "max-duy"]]);
  });

  it("leaves out a broken profile, keeps the hub, runner and the other profiles, and logs id, field and error", () => {
    const lines: string[] = [];
    const file = write({
      mode: "hub",
      hub: { url: "https://hive.test", token: "t" },
      runner: { acceptHubRuns: true },
      projects: [{ name: "app", repo: "/r/app" }],
      agents: [profile("claude-1"), profile("codex-2", { kind: "codex", maxConcurrent: 99 }), profile("claude-1")],
    });
    const { config, issues } = readDesktopConfig(file, (l) => lines.push(l));
    assert.equal(config?.mode, "hub");
    assert.equal(config?.hub.token, "t");
    assert.equal(config?.runner.acceptHubRuns, true);
    assert.deepEqual(config?.projects.map((p) => p.name), ["app"]);
    assert.deepEqual(config?.agents.map((a) => a.id), ["claude-1"]);
    assert.deepEqual(
      issues.map((i) => [i.section, i.id, i.field, i.action]),
      [
        ["agents", "codex-2", "maxConcurrent", "skipped"],
        ["agents", "claude-1", "id", "skipped"],
      ],
    );
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^config: .*config\.json agents\[codex-2\]\.maxConcurrent: .+ \(skipped\)$/);
    assert.match(lines[1]!, /agents\[claude-1\]\.id: duplicate/);
  });

  it("logs a broken key of any other part and uses its default for that part only", () => {
    const lines: string[] = [];
    const file = write({ mode: "hub", hub: { url: "https://hive.test", token: "t" }, runner: { maxParallel: "often" }, gitlab: 5, agents: [profile("claude-1")] });
    const { config, issues } = readDesktopConfig(file, (l) => lines.push(l));
    assert.equal(config?.hub.url, "https://hive.test");
    assert.deepEqual(config?.agents.map((a) => a.id), ["claude-1"]);
    assert.deepEqual(issues.map((i) => [i.section, i.action]).sort(), [["gitlab", "default"], ["runner", "default"]]);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.startsWith("config: ")));
  });

  it("logs a file that is not JSON instead of failing in silence", () => {
    const lines: string[] = [];
    const { config, issues } = readDesktopConfig(write("{ not json"), (l) => lines.push(l));
    assert.equal(config, null);
    assert.equal(issues[0]?.section, "file");
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /config: .*config\.json file: .+/);
  });

  it("logs the same issues once, not on every reload", () => {
    const lines: string[] = [];
    const file = write({ agents: [profile("Bad Id")] });
    const first = readDesktopConfig(file, (l) => lines.push(l));
    readDesktopConfig(file, (l) => lines.push(l), first.issues);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /agents\[Bad Id\]\.id/);
  });

  it("keeps a left-out profile in the file when settings are saved, and backs up a defaulted key", () => {
    const file = write({ gitlab: 5, agents: [profile("claude-1"), profile("codex-2", { kind: "codex", maxConcurrent: 99 })] });
    const { config } = readDesktopConfig(file, () => undefined);
    saveConfig({ ...config!, mode: "local", locale: "en" }, file);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.locale, "en");
    assert.deepEqual(saved.agents.map((a: { id: string }) => a.id), ["claude-1", "codex-2"], "the broken profile is still there to fix");
    assert.ok(existsSync(`${file}.bak`), "the bad gitlab value is kept in config.json.bak");
    assert.equal(JSON.parse(readFileSync(`${file}.bak`, "utf8")).gitlab, 5);

    // Made again in the app: the new profile replaces the broken one, and the warning goes.
    const again = readDesktopConfig(file, () => undefined);
    assert.deepEqual(again.issues.map((i) => i.id), ["codex-2"]);
    const codex = agentProfileSchema.parse(profile("codex-2", { kind: "codex" }));
    saveConfig({ ...again.config!, agents: [...again.config!.agents, codex] }, file);
    assert.deepEqual(readDesktopConfig(file, () => undefined).issues, []);
  });
});
