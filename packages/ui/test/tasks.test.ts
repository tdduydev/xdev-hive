import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setActiveLocale } from "#ui/i18n/translate.ts";
import { REQUEST_TONE, requestErrorText } from "#ui/lib/runs.ts";
import { ownerLabel } from "#ui/lib/tasks.ts";

describe("task helpers", () => {
  it("splits an agent's lease into its profile and machine, and leaves a person's name alone", () => {
    assert.deepEqual(ownerLabel("codex-1.hc-duytd20-macmini@hc-duytd20-macmini"), { who: "codex-1", machine: "hc-duytd20-macmini" });
    assert.deepEqual(ownerLabel("claude-1.duy-mbp"), { who: "claude-1", machine: "duy-mbp" }, "local mode has no token suffix");
    assert.deepEqual(ownerLabel("duy"), { who: "duy", machine: null });
    assert.deepEqual(ownerLabel("duy@duy-macbook"), { who: "duy", machine: null });
    assert.deepEqual(ownerLabel(".hidden"), { who: ".hidden", machine: null });
  });

  it("shows why a machine refused a run in the viewer's language when it sent a known key", () => {
    setActiveLocale("en");
    try {
      assert.equal(requestErrorText({ message: "Task AUTH-5 đang có run R-1.", key: "errors.taskHasRun", vars: { id: "AUTH-5", run: "R-1" } }), "Task AUTH-5 already has run R-1.");
      assert.equal(requestErrorText({ message: "git: not a repository", key: "errors.fromANewerApp" }), "git: not a repository", "unknown key: the message");
      assert.equal(requestErrorText({ message: "disk full" }), "disk full");
    } finally {
      setActiveLocale("vi");
    }
    assert.equal(requestErrorText({ message: "x", key: "errors.machineNoHubRuns", vars: { machine: "duy-mbp" } }), "Máy duy-mbp chưa bật Được nhận run từ hub.");
  });

  it("gives every request status a tone", () => {
    assert.deepEqual(Object.keys(REQUEST_TONE).sort(), ["accepted", "cancelled", "expired", "pending", "rejected"]);
  });
});
