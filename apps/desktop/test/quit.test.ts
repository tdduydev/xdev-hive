import assert from "node:assert/strict";
import { it } from "node:test";
import { QuitLifecycle } from "#desktop/main/quit.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("repeated quit waits for runner bookkeeping and the update helper", async () => {
  const quit = new QuitLifecycle();
  const runner = deferred();
  const update = deferred();
  const events: string[] = [];
  const cleanup = async () => {
    events.push("stop");
    await runner.promise;
    events.push("install");
    await update.promise;
  };
  const finish = () => { assert.equal(quit.ready, true); events.push("exit"); };
  const failed = () => assert.fail("unexpected cleanup failure");
  const pending = quit.start(cleanup, finish, failed);
  await quit.start(cleanup, finish, failed);
  assert.equal(quit.ready, false);
  assert.deepEqual(events, ["stop"]);
  runner.resolve();
  await Promise.resolve();
  await quit.start(cleanup, finish, failed);
  assert.equal(quit.ready, false);
  assert.deepEqual(events, ["stop", "install"]);
  update.resolve();
  await pending;
  await quit.start(cleanup, finish, failed);
  assert.deepEqual(events, ["stop", "install", "exit"]);
});

it("logs a failed cleanup and still finishes exactly once", async () => {
  const quit = new QuitLifecycle();
  const error = new Error("stop failed");
  const events: unknown[] = [];
  await quit.start(async () => { throw error; }, () => events.push("exit"), (err) => events.push(err));
  assert.equal(quit.ready, true);
  await quit.start(async () => assert.fail("second cleanup"), () => assert.fail("second exit"), () => assert.fail("second failure"));
  assert.deepEqual(events, [error, "exit"]);
});
