import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { may, type Me } from "@xdev-hive/core";
import { hasKey, translate } from "#ui/i18n/translate.ts";
import { canClearCooldown, canCloseTask, canEditChatSettings, canEditDependencies, contextProjects } from "#ui/lib/permission-controls.ts";

const account = (projects: NonNullable<Me["access"]>["projects"], role: Me["role"] = "member"): Me => ({
  name: "person", role, mode: "hub", access: { projects },
});

describe("hub permission controls", () => {
  it("1. lets task managers edit dependencies even without run dispatch, but not dispatchers without task management", () => {
    assert.equal(canEditDependencies(account({ app: { permissions: ["view", "taskManage"] } }), "app"), true);
    assert.equal(canEditDependencies(account({ app: { permissions: ["view", "runDispatch"] } }), "app"), false);
  });

  it("2. keeps chat settings read only for a person with chatUse alone", () => {
    const chat = account({ app: { permissions: ["view", "chatUse"] } });
    assert.equal(may(chat, "app", "chatUse"), true);
    assert.equal(canEditChatSettings(chat, "app"), false);
    assert.equal(canEditChatSettings(account({ app: { permissions: ["view", "projectSettings"] } }), "app"), true);
  });

  it("3. describes reviewer approval without promising context skill approval", () => {
    const reviewer = account({ app: "reviewer" });
    assert.equal(may(reviewer, "app", "docApprove"), true);
    assert.equal(may(reviewer, "app", "contextEdit"), false);
    for (const locale of ["vi", "en"] as const) assert.doesNotMatch(translate("projectRoleHint.reviewer", undefined, locale), /skill/i);
  });

  it("4. follows the cooldown method's agent role floor across project grants", () => {
    assert.equal(canClearCooldown(account({ app: "viewer" }, "viewer")), false);
    assert.equal(canClearCooldown(account({ app: "viewer" }, "member")), true);
    assert.equal(canClearCooldown(account({}, "agent")), true);
  });

  it("5. uses the menu names and removes stale operation labels", () => {
    assert.equal(translate("nav.proposals", undefined, "vi"), "Đề xuất");
    assert.equal(translate("nav.systems", undefined, "vi"), "Hệ thống");
    assert.equal(hasKey("ops.nav.review"), false);
    assert.equal(hasKey("ops.nav.projects"), false);
  });

  it("6. limits Context agent to projects where a lead may edit context", () => {
    const lead = account({ app: "lead", other: "reviewer", hidden: "viewer" });
    assert.deepEqual(contextProjects(lead, ["app", "other", "hidden"]), ["app"]);
    assert.deepEqual(contextProjects(account({ app: "reviewer" }), ["app"]), []);
  });

  it("7. requires both task work and code review before offering Done", () => {
    assert.equal(canCloseTask(account({ app: "member" }), "app"), false);
    assert.equal(canCloseTask(account({ app: { permissions: ["view", "codeReview"] } }), "app"), false);
    assert.equal(canCloseTask(account({ app: "reviewer" }), "app"), true);
    assert.equal(translate("tasks.doneNeedsReview", undefined, "vi"), "Cần quyền review code để đóng task");
    assert.match(translate("tasks.doneNeedsReview", undefined, "en"), /Code review/);
  });
});
