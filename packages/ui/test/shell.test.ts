import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextTaskId } from "../src/lib/tasks.ts";
import { fold } from "../src/lib/text.ts";

describe("shell helpers", () => {
  it("suggests the next task id from the prefix most tasks of the project use", () => {
    assert.equal(nextTaskId([]), "T-001", "a new project starts at T-001");
    assert.equal(nextTaskId([{ id: "T-009" }, { id: "T-010" }, { id: "T-002" }]), "T-011");
    assert.equal(nextTaskId([{ id: "AUTH-7" }, { id: "AUTH-12" }, { id: "T-1" }]), "AUTH-13", "the common prefix wins");
    assert.equal(nextTaskId([{ id: "T-099" }]), "T-100", "grows past the padding");
    assert.equal(nextTaskId([{ id: "spike" }, { id: "readme" }]), "T-001", "ids without a number are ignored");
  });

  it("folds case and Vietnamese diacritics for search", () => {
    assert.equal(fold("Tài liệu"), "tai lieu");
    assert.equal(fold("Đi tới Lượt chạy"), "di toi luot chay");
    assert.ok(fold("Quy chuẩn code").includes(fold("chuan")));
  });
});
