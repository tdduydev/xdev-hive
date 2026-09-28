import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { HiveError, type Actor, type HiveEvent } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "../src/app.ts";
import { TokenStore } from "../src/tokens.ts";
import { UserStore } from "../src/users.ts";
import { eventMessage, urlHint, WebhookDispatcher, WebhookStore, webhookPayload } from "../src/webhooks.ts";

const admin: Actor = { name: "duy", role: "admin" };
const claude: Actor = { name: "claude@duy", role: "agent" };
const code = (c: string) => (e: unknown) => e instanceof HiveError && e.code === c;

// A local receiver standing in for Teams and Slack: records what arrives, answers with `status`.
let receiver = "";
let status = 200;
const received: Array<{ path: string; body: any }> = [];
let closeReceiver: () => void;
before(async () => {
  const server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body: JSON.parse(body) });
      res.writeHead(status).end();
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  receiver = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeReceiver = () => server.close();
});
after(() => closeReceiver());

function setup() {
  let dispatch: (e: HiveEvent) => Promise<void> = async () => undefined;
  const pending: Promise<void>[] = [];
  const hive = new SqliteHive(":memory:", { memoryRequiresApproval: true, onEvent: (e) => void pending.push(dispatch(e)) });
  const store = new WebhookStore(hive.db);
  const dispatcher = new WebhookDispatcher(store, { publicUrl: "https://hive.example.com" });
  dispatch = (e) => dispatcher.notify(e);
  const settle = async () => {
    await Promise.all(pending.splice(0));
  };
  return { hive, store, dispatcher, settle };
}

describe("webhook store", () => {
  it("keeps the URL secret, refuses plain http outside this host, and keeps the URL on an update without one", () => {
    const { store } = setup();
    assert.throws(() => store.save({ name: "x", kind: "slack", url: "http://hooks.example.com/abc", events: ["proposal.created"], projects: [], locale: "vi", enabled: true }), code("bad_request"));
    assert.throws(() => store.save({ name: "x", kind: "slack", url: "https://hooks.slack.com/a", events: [], projects: [], locale: "vi", enabled: true }), code("bad_request"));
    assert.throws(() => store.save({ name: "x", kind: "slack", url: "https://hooks.slack.com/a", events: ["proposal.created"], projects: ["Bad Name"], locale: "vi", enabled: true }), code("bad_request"));
    const saved = store.save({ name: "Dev", kind: "slack", url: "https://hooks.slack.com/services/T1/B2/abcdSECRET9x", events: ["proposal.created"], projects: [], locale: "vi", enabled: true });
    assert.equal(saved.urlHint, "https://hooks.slack.com/…ET9x");
    assert.equal(JSON.stringify(store.list()).includes("SECRET"), false);
    const renamed = store.save({ id: saved.id, name: "Dev channel", kind: "slack", events: ["proposal.created"], projects: [], locale: "en", enabled: true });
    assert.equal(renamed.urlHint, saved.urlHint);
    assert.equal(store.get(saved.id)!.url, "https://hooks.slack.com/services/T1/B2/abcdSECRET9x");
    assert.equal(urlHint("https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=XYZ1"), "https://prod-12.westus.logic.azure.com/…XYZ1");
  });
});

describe("webhook messages", () => {
  it("reads in the webhook's language and shapes the payload for each service", () => {
    const event: HiveEvent = {
      type: "proposal.created",
      project: "app",
      proposal: { id: 1, docKey: "project/app/agents", baseVersion: 1, content: "", reason: "Thêm lệnh test", author: "claude@duy", status: "pending", reviewer: null, reviewNote: null, decidedAt: null, source: null, createdAt: "" },
    };
    assert.deepEqual(eventMessage(event, "vi"), { text: "Đề xuất sửa project/app/agents (app) từ claude@duy: Thêm lệnh test", page: "#/proposals" });
    assert.match(eventMessage(event, "en").text, /^Proposed change to project\/app\/agents/);
    const link = { title: "Open", url: "https://hive.example.com/#/proposals" };
    assert.deepEqual(webhookPayload("slack", "hi", link), { text: "hi\n<https://hive.example.com/#/proposals|Open>" });
    const card = webhookPayload("teams", "hi", link) as any;
    assert.equal(card.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
    assert.deepEqual(card.attachments[0].content.body, [{ type: "TextBlock", text: "hi", wrap: true }]);
    assert.deepEqual(card.attachments[0].content.actions, [{ type: "Action.OpenUrl", title: "Open", url: link.url }]);
  });
});

describe("webhook dispatch", () => {
  it("posts hub events to the webhooks that want them, per event and project", async () => {
    const { hive, store, settle } = setup();
    received.length = 0;
    status = 200;
    const all = store.save({ name: "All", kind: "slack", url: `${receiver}/all`, events: ["proposal.created", "memory.pending"], projects: [], locale: "vi", enabled: true });
    store.save({ name: "Billing", kind: "teams", url: `${receiver}/billing`, events: ["proposal.created"], projects: ["billing"], locale: "en", enabled: true });
    store.save({ name: "Off", kind: "slack", url: `${receiver}/off`, events: ["proposal.created"], projects: [], locale: "vi", enabled: false });

    await hive.call("docs.save", { key: "project/app/agents", content: "# app" }, admin);
    await hive.call("proposals.create", { docKey: "project/app/agents", baseVersion: 1, content: "# app\n\nmore", reason: "Thêm" }, claude);
    await hive.call("memory.write", { project: "app", kind: "gotcha", content: "Node 26" }, claude); // pending: the hub wants approval
    await hive.call("memory.write", { project: "app", kind: "gotcha", content: "By an admin" }, admin); // approved at once: no event
    await settle();

    assert.deepEqual(received.map((r) => r.path), ["/all", "/all"]);
    assert.match(received[0]!.body.text, /^Đề xuất sửa project\/app\/agents \(app\) từ claude@duy: Thêm\n<https:\/\/hive\.example\.com\/#\/proposals\|Mở trong hub>$/);
    assert.match(received[1]!.body.text, /^Memory chờ duyệt \(app\) từ claude@duy: Node 26/);
    assert.equal(store.list().find((w) => w.id === all.id)!.lastError, null);
  });

  it("records a failed send without the URL, and reports a test send", async () => {
    const { store, dispatcher } = setup();
    status = 500;
    const w = store.save({ name: "Broken", kind: "teams", url: `${receiver}/broken`, events: ["proposal.created"], projects: [], locale: "vi", enabled: true });
    assert.deepEqual(await dispatcher.test(w.id), { ok: false, error: "HTTP 500" });
    status = 200;
    assert.deepEqual(await dispatcher.test(w.id), { ok: true, error: null });
    assert.match(received.at(-1)!.body.attachments[0].content.body[0].text, /webhook "Broken" đã kết nối/);

    const gone = store.save({ name: "Gone", kind: "slack", url: "http://127.0.0.1:9/secret-path", events: ["proposal.created"], projects: [], locale: "vi", enabled: true });
    assert.deepEqual(await dispatcher.test(gone.id), { ok: false, error: "network error" });
    assert.equal(JSON.stringify(store.list()).includes("secret-path"), false);
  });

  it("posts failed runs and new merge requests, the MR linking to itself", async () => {
    const { hive, store, settle } = setup();
    received.length = 0;
    status = 200;
    store.save({ name: "Runs", kind: "teams", url: `${receiver}/runs`, events: ["run.failed", "mr.created"], projects: ["app"], locale: "en", enabled: true });
    const runner: Actor = { name: "runner.duy-mbp@duy", role: "agent" };
    const base = { project: "app", taskId: "T-1", taskTitle: "Login page", runId: "R-1fa9e2", profileId: "claude-1", role: "implement" as const };
    await hive.call("runs.report", { kind: "failed", ...base, error: "TypeError: boom" }, runner);
    await hive.call("runs.report", { kind: "mr", ...base, mrUrl: "https://gitlab.example.com/g/app/-/merge_requests/7", mrIid: 7 }, runner);
    await hive.call("runs.report", { kind: "failed", ...base, project: "billing" }, runner); // another project: not this webhook
    await settle();
    const cards = received.map((r) => r.body.attachments[0].content);
    assert.deepEqual(
      cards.map((c) => c.body[0].text),
      ["Run R-1fa9e2 failed (app · T-1: Login page) on runner.duy-mbp@duy: TypeError: boom", "New merge request !7 (app · T-1: Login page) from run R-1fa9e2."],
    );
    assert.deepEqual(cards[0].actions[0], { type: "Action.OpenUrl", title: "Open in the hub", url: "https://hive.example.com/#/machines" });
    assert.deepEqual(cards[1].actions[0], { type: "Action.OpenUrl", title: "Open the merge request", url: "https://gitlab.example.com/g/app/-/merge_requests/7" });
  });

  it("tells about install requests and how they end", async () => {
    const { hive, store, settle } = setup();
    received.length = 0;
    store.save({ name: "Ops", kind: "slack", url: `${receiver}/ops`, events: ["command.requested", "command.finished"], projects: [], locale: "en", enabled: true });
    const mbp: Actor = { name: "runner.duy-mbp@duy", role: "agent" };
    const report = { machine: [{ id: "cli:codex", label: "Codex CLI", state: "missing" as const, detail: "", action: "Install with npm" }], projects: [] };
    await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "aaaaaaaa", setup: { checkedAt: new Date().toISOString(), report } }, mbp);
    const cmd = await hive.call("admin.commandCreate", { machineId: mbp.name, itemId: "cli:codex" }, admin);
    await hive.call("machines.commandResult", { id: cmd.id, status: "running" }, mbp);
    await hive.call("machines.commandResult", { id: cmd.id, status: "failed" }, mbp);
    await settle();
    assert.deepEqual(
      received.map((r) => r.body.text.split("\n")[0]),
      ["duy asked for Install with npm: Codex CLI on runner.duy-mbp@duy; waiting for that machine's user.", "Install with npm: Codex CLI on runner.duy-mbp@duy: failed."],
    );
  });
});

describe("webhook routes", () => {
  it("are for hub admins only, and never return a URL", async () => {
    const { hive, store, dispatcher } = setup();
    const tokens = new TokenStore(hive.db);
    const adminToken = tokens.create("ops", "admin").token;
    const agentToken = tokens.create("ci", "agent").token;
    const server = createHubApp({ hive, tokens, users: new UserStore(hive.db), allowedHosts: ["127.0.0.1"], webhooks: { store, dispatcher } }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const rpc = async (token: string, method: string, input: unknown = {}) => {
      const res = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ method, input }) });
      return { status: res.status, text: await res.text() };
    };
    try {
      assert.equal((await rpc(agentToken, "webhooks.list")).status, 403);
      const saved = await rpc(adminToken, "webhooks.save", { name: "Dev", kind: "slack", url: "https://hooks.slack.com/services/T/B/topSECRET", events: ["proposal.created"], projects: [], locale: "vi", enabled: true });
      assert.equal(saved.status, 200, saved.text);
      const listed = await rpc(adminToken, "webhooks.list");
      assert.equal(listed.text.includes("topSECRET"), false);
      assert.equal(JSON.parse(listed.text).result.length, 1);
      const audit = await hive.call("admin.audit", {}, admin);
      assert.equal(audit[0]!.action, "webhooks.save");
      assert.equal(audit[0]!.detail.includes("SECRET"), false);
    } finally {
      server.close();
    }
  });
});
