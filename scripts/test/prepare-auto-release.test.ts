import assert from "node:assert/strict";
import { it } from "node:test";
import { prepareRelease } from "#scripts/prepare-auto-release.mjs";
it("bumps metadata and marks only roadmap tasks in the green batch", () => {
  const roadmap = '- [ ] **60c. auto-release**\n- [ ] **60d. chat**\n';
  const next = prepareRelease('{"version":"0.142.0"}', roadmap, "0.143.0", ["R-60c"]);
  assert.equal(JSON.parse(next.manifest).version, "0.143.0");
  assert.equal(next.roadmap, '- [x] **60c. auto-release**\n- [ ] **60d. chat**\n');
  assert.throws(() => prepareRelease('{"version":"0.142.0"}', roadmap, "0.142.0", []));
  assert.throws(() => prepareRelease('{"version":"0.142.0"}', roadmap, "0.141.9", []));
});
