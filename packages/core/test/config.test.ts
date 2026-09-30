import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { agentActorName, configSchema, loadConfig, machineIdFrom, pinMachine } from "#core/node.ts";

describe("machine name", () => {
  it("derives a short id from the hostname", () => {
    assert.equal(machineIdFrom("Duys-MacBook-Pro.local"), "duys-macbook-pro");
    assert.equal(machineIdFrom("DESKTOP_7Q2 LAB"), "desktop-7q2-lab");
    assert.equal(machineIdFrom("a-very-long-hostname-for-a-build-agent.ci"), "a-very-long-hostname-for");
    assert.equal(machineIdFrom("--.local"), "host");
    assert.equal(machineIdFrom(""), "host");
  });

  it("puts the machine in hub actor names, the OS user in local ones", () => {
    assert.equal(agentActorName("claude-1", "hub", "duy-mbp", "admin"), "claude-1.duy-mbp");
    assert.equal(agentActorName("claude-1", "local", "duy-mbp", "admin"), "claude-1@admin");
  });

  it("keeps the interface language, Vietnamese until the app says otherwise", () => {
    assert.equal(configSchema.parse({}).locale, "vi");
    assert.equal(configSchema.parse({ locale: "en" }).locale, "en");
  });

  it("rejects an invalid machine in config.json", () => {
    assert.throws(() => configSchema.parse({ machine: "Duy MBP" }), /machine/);
  });

  it("pins the hostname default into an existing config.json, once", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "hive-config-")), "config.json");
    pinMachine(loadConfig(file), file);
    assert.throws(() => readFileSync(file), /ENOENT/, "no config.json is created");

    writeFileSync(file, JSON.stringify({ mode: "hub", hub: { url: "https://hive.test", token: "t" } }));
    const config = loadConfig(file);
    pinMachine(config, file);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).machine, machineIdFrom(os.hostname()));

    writeFileSync(file, JSON.stringify({ mode: "hub", machine: "ci-runner-2" }));
    pinMachine(loadConfig(file), file);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).machine, "ci-runner-2");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).hub, undefined, "a pinned file is not rewritten");
  });
});
