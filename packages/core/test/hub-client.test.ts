import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { HiveError, HubBackend } from "../src/index.ts";

/** A port nothing listens on: bind one, then close it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe("hub client", () => {
  it("reports a hub it cannot reach as unavailable, with the catalogue key", async () => {
    const hub = new HubBackend(`http://127.0.0.1:${await closedPort()}`, "t".repeat(40));
    await assert.rejects(
      () => hub.call("docs.list", {}, { name: "duy", role: "admin" }),
      (err: unknown) => err instanceof HiveError && err.code === "unavailable" && err.key === "errors.hubUnreachable" && typeof err.vars?.reason === "string",
    );
    await assert.rejects(() => hub.me("desktop"), (err: unknown) => err instanceof HiveError && err.code === "unavailable");
  });
});
