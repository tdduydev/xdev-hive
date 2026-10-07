import assert from "node:assert/strict";
import { it } from "node:test";
import { trustedRendererUrl } from "#desktop/main/ipc-trust.ts";

it("only trusts the packaged renderer document, allowing its hash routes", () => {
  const target = "file:///app/renderer/index.html";
  assert.equal(trustedRendererUrl(`${target}#/tasks`, target), true);
  for (const url of ["file:///tmp/other.html", `${target}.evil`, "https://example.test/", "invalid"]) {
    assert.equal(trustedRendererUrl(url, target), false);
  }
});

it("rejects dev origin and path prefix lookalikes and credentials", () => {
  const target = "http://localhost:5173/";
  assert.equal(trustedRendererUrl(`${target}?dev=1#/tasks`, target), true);
  for (const url of ["http://localhost:51730/", "http://localhost:5173/evil", "http://localhost:5173.evil.test/", "http://user@localhost:5173/", "https://localhost:5173/"]) {
    assert.equal(trustedRendererUrl(url, target), false);
  }
});
