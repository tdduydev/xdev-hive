import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rehydrateError, withHiveErrors } from "#desktop/renderer/bridge-errors.ts";

describe("errors across the context bridge", () => {
  it("a bridged error becomes an Error again, with the key the page translates", () => {
    const e = rehydrateError({ hiveError: true, code: "bad_request", message: "Set the GitLab URL and token first.", key: "errors.gitlabNoToken", vars: { a: 1 } });
    assert.ok(e instanceof Error);
    assert.deepEqual([(e as Error).message, (e as { code?: string }).code, (e as { key?: string }).key, (e as { vars?: unknown }).vars], ["Set the GitLab URL and token first.", "bad_request", "errors.gitlabNoToken", { a: 1 }]);
    const other = new TypeError("x");
    assert.equal(rehydrateError(other), other, "anything else passes as it is");
  });

  it("wraps the client and its desktop part; values and successes pass through", async () => {
    const reject = () => Promise.reject({ hiveError: true, message: "m", key: "errors.notFound" });
    const client = withHiveErrors({ call: reject, version: 3, desktop: { settings: () => Promise.resolve({ ok: 1 }), removeProject: reject } });
    assert.equal(client.version, 3);
    assert.deepEqual(await client.desktop.settings(), { ok: 1 });
    await assert.rejects(client.call(), (e: unknown) => e instanceof Error && (e as { key?: string }).key === "errors.notFound");
    await assert.rejects(client.desktop.removeProject(), (e: unknown) => e instanceof Error && (e as { key?: string }).key === "errors.notFound");
  });
});
