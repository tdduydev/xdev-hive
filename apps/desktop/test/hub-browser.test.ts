import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { HiveError } from "@xdev-hive/core";
import { landingPage, signInThroughBrowser } from "../src/main/hub-browser.ts";

// A hub that only knows the exchange: the code it gave out and the challenge the app sent with it.
const issued = new Map<string, string>();
let hub = "";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { code, verifier } = JSON.parse(body || "{}");
    const challenge = issued.get(code);
    issued.delete(code);
    const ok = challenge && createHash("sha256").update(verifier).digest("base64url") === challenge;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { result: { token: "hive_machine", user: { username: "lan" } } } : { error: { message: "bad code", key: "errors.deviceCode" } }));
  });
});
before(async () => {
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** Plays the person in the browser: reads the app's link, then lands on its loopback address. */
function browser(choice: (req: { port: number; state: string; challenge: string; name: string }) => Record<string, string>) {
  const seen: string[] = [];
  let read: Promise<void> = Promise.resolve();
  return {
    seen,
    /** Resolves once the browser has read the page it landed on. */
    finished: () => read,
    open: async (url: string) => {
      seen.push(url);
      const params = new URLSearchParams(url.split("#/device?")[1]);
      const req = { port: Number(params.get("port")), state: params.get("state")!, challenge: params.get("challenge")!, name: params.get("name")! };
      read = fetch(`http://127.0.0.1:${req.port}/callback?${new URLSearchParams(choice(req)).toString()}`).then(async (r) => {
        seen.push(await r.text());
      });
    },
  };
}
const page = (o: string) => `<p>${o}</p>`;
const key = (k: string) => (e: unknown) => e instanceof HiveError && e.key === k;

describe("desktop sign-in through the browser", () => {
  it("opens the hub's page and trades the code it gets back for a token", async () => {
    const b = browser((r) => {
      const code = randomBytes(8).toString("hex");
      issued.set(code, r.challenge);
      return { code, state: r.state };
    });
    const result = await signInThroughBrowser({ hubUrl: `${hub}/`, machine: "duy-mbp", open: b.open, page });
    await b.finished();
    assert.equal(result.token, "hive_machine");
    assert.match(b.seen[0]!, new RegExp(`^${hub}/#/device\\?port=\\d+&state=[\\w-]{32}&challenge=[\\w-]{43}&name=duy-mbp$`));
    assert.equal(b.seen[1], "<p>done</p>");
  });

  it("stops when the person denies it", async () => {
    const b = browser((r) => ({ error: "denied", state: r.state }));
    await assert.rejects(signInThroughBrowser({ hubUrl: hub, machine: "m", open: b.open, page }), key("errors.deviceDenied"));
    await b.finished();
    assert.equal(b.seen[1], "<p>denied</p>");
  });

  it("ignores a call without its state, and gives up after the timeout or on cancel", async () => {
    const stray = browser(() => ({ code: "x", state: "someone-else" }));
    await assert.rejects(signInThroughBrowser({ hubUrl: hub, machine: "m", open: stray.open, page, timeoutMs: 300 }), key("errors.deviceTimeout"));
    await stray.finished();
    assert.equal(stray.seen[1], "", "404 for the wrong state");

    const controller = new AbortController();
    const waiting = signInThroughBrowser({ hubUrl: hub, machine: "m", open: async () => controller.abort(), page, signal: controller.signal });
    await assert.rejects(waiting, key("errors.deviceCancelled"));
  });

  it("reports a code the hub does not accept", async () => {
    const b = browser((r) => ({ code: "never-issued", state: r.state }));
    await assert.rejects(signInThroughBrowser({ hubUrl: hub, machine: "m", open: b.open, page }), key("errors.deviceCode"));
  });

  it("escapes the landing text", () => {
    assert.match(landingPage("xDev <Hive>", `a "b" & c`), /<title>xDev &#60;Hive&#62;<\/title>.*a &#34;b&#34; &#38; c/);
  });
});
