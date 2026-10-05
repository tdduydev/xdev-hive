import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatFileUrl } from "@xdev-hive/core";
import { chatFileId, chatNotice, hubChatUpload, servedName } from "#desktop/main/chat.ts";
import { setMainLocale } from "#desktop/main/i18n.ts";

describe("the leader chat in the app (roadmap 48)", () => {
  it("reads only its own chat file addresses", () => {
    assert.equal(chatFileId(chatFileUrl(12)), 12);
    assert.equal(chatFileId("hive-file://chat/12/"), 12);
    for (const url of ["hive-file://chat/", "hive-file://chat/1a", "hive-file://other/1", "https://hub/api/chat/files/1", "hive-file://chat/1/../2"]) assert.equal(chatFileId(url), null, url);
    assert.equal(servedName("attachment; filename*=UTF-8''l%E1%BB%97i.png"), "lỗi.png");
    assert.equal(servedName(null), null);
  });

  it("tells the person who wrote the message, only while the window is away", () => {
    const req = { project: "app", text: "Why does login fail?\nmore", requestedBy: "desktop@lan" };
    const away = { me: "desktop@lan", windowShown: false };
    setMainLocale("en");
    try {
      assert.deepEqual(chatNotice(req, "done", away), { title: "The leader of app replied", body: "To: Why does login fail?. Click to open the chat." });
      assert.match(chatNotice(req, "failed", away)!.title, /could not reply/);
    } finally {
      setMainLocale("vi");
    }
    assert.equal(chatNotice(req, "done", { ...away, windowShown: true }), null, "the page shows it already");
    assert.equal(chatNotice(req, "done", { ...away, me: "desktop@binh" }), null, "someone else's message, written on this machine");
    assert.equal(chatNotice(req, "done", { ...away, me: null }), null);
  });

  it("uploads to the hub under the app's label, and says the hub's reason in the page's words", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const answer = (status: number, body: unknown) => async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    };
    const hub = { url: "https://hive.example.test/", token: "hive_t" };
    const file = { id: 3, name: "a.png", type: "image/png", size: 4, createdAt: "" };
    assert.deepEqual(await hubChatUpload(hub, "desktop", "app", "a b.png", new Uint8Array([1, 2]), answer(200, { result: file })), file);
    assert.equal(seen[0]!.url, "https://hive.example.test/api/chat/files?project=app&name=a%20b.png");
    assert.deepEqual([seen[0]!.headers.authorization, seen[0]!.headers["x-hive-agent"]], ["Bearer hive_t", "desktop"], "chat.send attaches only the same actor's uploads");
    await assert.rejects(
      hubChatUpload(hub, "desktop", "app", "a.png", new Uint8Array([1]), answer(403, { error: { code: "forbidden", message: "needs chatUse", key: "errors.need.chatUse", vars: { project: "app" } } })),
      (err: { code?: string; key?: string }) => err.code === "forbidden" && err.key === "errors.need.chatUse",
    );
  });
});
