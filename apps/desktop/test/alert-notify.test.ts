import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HubAlert, Me } from "@xdev-hive/core";
import { translate } from "@xdev-hive/ui/i18n";
import { AlertWatch, fetchAlerts, isHubAdmin, MAX_SINGLE, noticeText, type AlertNotice } from "#desktop/main/alert-notify.ts";

const T0 = Date.parse("2026-10-02T08:00:00Z");
const admin: Me = { name: "duy", role: "admin", mode: "hub" };

function alert(id: number, minutesBefore: number, extra: Partial<HubAlert> = {}): HubAlert {
  const at = new Date(T0 - minutesBefore * 60_000).toISOString();
  return {
    id,
    rule: "machine_offline",
    key: `m${id}`,
    severity: "medium",
    vars: { machine: `mac-${id}`, minutes: 61 },
    project: null,
    openedAt: at,
    lastSeenAt: at,
    resolvedAt: null,
    resolvedBy: null,
    ackedBy: null,
    ackedAt: null,
    ...extra,
  };
}

/** A watch over a hub whose open alerts and caller the test sets, with its own clock. */
function setup(me: Me = admin) {
  const state = { now: T0, open: [] as HubAlert[], me, meCalls: 0, listCalls: 0, fail: false };
  const shown: AlertNotice[] = [];
  const watch = new AlertWatch({
    me: async () => (state.meCalls++, state.me),
    list: async () => {
      state.listCalls++;
      if (state.fail) throw new Error("offline");
      return { open: state.open };
    },
    notify: (n) => shown.push(n),
    now: () => state.now,
  });
  const later = async (minutes: number) => {
    state.now += minutes * 60_000;
    return watch.tick();
  };
  return { state, shown, watch, later };
}

describe("alert notifications on the desktop (roadmap 22m-2)", () => {
  it("only a hub admin, not a restricted account or a local app", () => {
    assert.equal(isHubAdmin(admin), true);
    assert.equal(isHubAdmin({ ...admin, role: "member" }), false);
    assert.equal(isHubAdmin({ ...admin, access: { projects: {} } as unknown as Me["access"] }), false);
    assert.equal(isHubAdmin({ ...admin, mode: "local" }), false);
  });

  it("does not ask for alerts with a token that is not a hub admin's", async () => {
    const { state, shown, watch } = setup({ ...admin, role: "agent" });
    state.open = [alert(1, 0)];
    assert.deepEqual(await watch.tick(), []);
    assert.equal(state.listCalls, 0);
    assert.deepEqual(shown, []);
  });

  it("tells about each new alert once, and not about old or acknowledged ones at start", async () => {
    const { state, shown, watch, later } = setup();
    state.open = [alert(1, 30), alert(2, 5), alert(3, 1, { ackedBy: "hoa" })];
    await watch.tick();
    assert.deepEqual(
      shown.map((n) => n.kind === "one" && n.alert.id),
      [2],
      "opened 30 minutes ago: older than the grace; acknowledged: someone saw it",
    );
    state.open.push(alert(4, -1));
    await later(1);
    await later(1);
    assert.deepEqual(
      shown.map((n) => n.kind === "one" && n.alert.id),
      [2, 4],
    );
  });

  it("asks the hub at most once a minute however often the heartbeat comes", async () => {
    const { state, watch, later } = setup();
    await watch.tick();
    await later(0.5);
    await later(0.4);
    assert.equal(state.listCalls, 1);
    await later(0.2);
    assert.equal(state.listCalls, 2);
  });

  it("asks who the token is only every 10 minutes", async () => {
    const { state, later, watch } = setup();
    await watch.tick();
    for (let i = 0; i < 5; i++) await later(1);
    assert.equal(state.meCalls, 1);
    await later(5);
    assert.equal(state.meCalls, 2);
  });

  it("puts many new alerts into one notification", async () => {
    const { state, shown, watch } = setup();
    state.open = Array.from({ length: MAX_SINGLE + 2 }, (_, i) => alert(i + 1, 0));
    const notices = await watch.tick();
    assert.equal(notices.length, 1);
    assert.equal(shown.length, 1);
    assert.equal(shown[0]!.kind, "many");
    assert.equal(shown[0]!.kind === "many" && shown[0]!.alerts.length, MAX_SINGLE + 2);
  });

  it("an alert that reopens has a new id and shows again; one that stays open does not", async () => {
    const { state, shown, watch, later } = setup();
    state.open = [alert(1, 0)];
    await watch.tick();
    await later(1);
    state.open = [];
    await later(1);
    state.open = [alert(2, -2, { key: "m1" })];
    await later(1);
    assert.equal(shown.length, 2);
  });

  it("a hub that cannot be reached is tried again on the next minute", async () => {
    const { state, shown, watch, later } = setup();
    state.fail = true;
    state.open = [alert(1, 0)];
    assert.deepEqual(await watch.tick(), []);
    state.fail = false;
    await later(1);
    assert.equal(shown.length, 1);
  });

  it("starts over for another hub or token", async () => {
    const { state, shown, watch } = setup();
    state.open = [alert(1, 0)];
    await watch.tick();
    watch.reset();
    await watch.tick();
    assert.equal(shown.length, 2);
    assert.equal(state.meCalls, 2);
  });

  it("words the notification as the webhook does, in the app's language", () => {
    const tr = (key: Parameters<typeof translate>[0], vars?: Record<string, string | number>) => translate(key, vars, "vi");
    const one = noticeText(tr, { kind: "one", alert: alert(1, 0, { severity: "high" }) }, (iso) => iso);
    assert.equal(one.title, "[Cao] Máy mac-1 offline");
    assert.equal(one.body, "không heartbeat 61 phút");
    const resting = alert(2, 0, { rule: "vendor_resting", vars: { vendor: "claude", count: 2, until: "2026-10-02T09:00:00Z" } });
    assert.match(noticeText(tr, { kind: "one", alert: resting }, () => "16:00").body, /rảnh lúc 16:00/);
    const many = noticeText(tr, { kind: "many", alerts: [alert(1, 0), alert(2, 0), alert(3, 0), alert(4, 0)] }, (iso) => iso);
    assert.equal(many.title, "4 cảnh báo mới trên hub");
    assert.match(many.body, /^Máy mac-1 offline; Máy mac-2 offline; .*Bấm để mở trang Cảnh báo\.$/);
  });

  it("reads alerts.list over the hub's RPC with the machine's token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ result: { open: [alert(1, 0)], recent: [], rules: [] } }), { status: 200 });
    };
    const got = await fetchAlerts({ url: "https://hive.example", token: "tok" }, fake);
    assert.equal(got.open.length, 1);
    assert.equal(calls[0]!.url, "https://hive.example/api/rpc");
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer tok");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { method: "alerts.list", input: {} });
    const denied = async () => new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 });
    await assert.rejects(fetchAlerts({ url: "https://hive.example", token: "tok" }, denied), /HTTP 403/);
  });
});
