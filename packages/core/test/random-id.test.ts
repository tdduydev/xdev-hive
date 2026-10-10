import assert from "node:assert/strict";
import { it } from "node:test";
import { randomId } from "#core/random-id.ts";

it("generates distinct version 4 UUIDs when randomUUID is unavailable", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  const nativeCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: (bytes: Uint8Array) => nativeCrypto.getRandomValues(bytes) },
  });
  try {
    const ids = Array.from({ length: 256 }, () => randomId());
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});
