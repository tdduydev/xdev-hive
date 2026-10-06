import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleInterval } from "#ui/lib/visible-interval.ts";

class Page extends EventTarget {
  hidden = false;
  hide(hidden: boolean) {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

it("stops polling while hidden, refreshes on return, and removes its timer/listener on disposal", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const page = new Page();
  let calls = 0;
  const stop = visibleInterval(1000, () => calls++, page);
  t.mock.timers.tick(2000);
  assert.equal(calls, 2);
  page.hide(true);
  t.mock.timers.tick(15 * 60_000);
  assert.equal(calls, 2, "no hidden polling, even over the OOM reproduction duration");
  page.hide(false);
  assert.equal(calls, 3, "one refresh rather than replaying 900 missed polls");
  t.mock.timers.tick(1000);
  assert.equal(calls, 4);
  stop();
  stop();
  page.hide(true);
  page.hide(false);
  t.mock.timers.tick(60_000);
  assert.equal(calls, 4, "unmounted pages have no timer or visibility listener");
});

it("does not create a poll on an initially hidden page, or duplicate timers across visibility events", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const page = new Page();
  page.hidden = true;
  let calls = 0;
  const stop = visibleInterval(1000, () => calls++, page);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 0);
  page.hide(false);
  page.hide(false);
  const refreshed = calls;
  t.mock.timers.tick(1000);
  assert.equal(calls, refreshed + 1, "only one timer remains");
  stop();
});
