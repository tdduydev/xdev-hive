import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatFileName, HiveError, sniffChatFile, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "manage" } } };
const other: Actor = { name: "minh", role: "member", access: { projects: { app: "manage" } } };
const reader: Actor = { name: "hoa", role: "member", access: { projects: { app: "view" } } };
const outsider: Actor = { name: "khoa", role: "member", access: { projects: { site: "manage" } } };

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "rest");

async function refusal(call: () => unknown): Promise<string | undefined> {
  try {
    await call();
  } catch (err) {
    assert.ok(err instanceof HiveError, String(err));
    return err.key ?? err.code;
  }
  assert.fail("expected a refusal");
}

describe("chat attachments", () => {
  it("reads what a file is from its bytes, and text only by name and valid UTF-8", () => {
    assert.equal(sniffChatFile("shot.txt", PNG), "image/png", "the bytes win over the name");
    assert.equal(sniffChatFile("a", bytes([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffChatFile("a", bytes("GIF89a...")), "image/gif");
    assert.equal(sniffChatFile("a", bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ")), "image/webp");
    assert.equal(sniffChatFile("spec", bytes("%PDF-1.7")), "application/pdf");
    assert.equal(sniffChatFile("run.log", bytes("Lỗi: exit 1\n")), "text/plain");
    assert.equal(sniffChatFile("notes.MD", bytes("# Ghi chú")), "text/markdown");
    assert.equal(sniffChatFile("rows.csv", bytes("a,b\n1,2")), "text/csv");
    assert.equal(sniffChatFile("x.json", bytes("{}")), "application/json");
    assert.equal(sniffChatFile("page.html", bytes("<script>")), null, "HTML is not taken");
    assert.equal(sniffChatFile("logo.svg", bytes("<svg onload=x>")), null, "SVG can run scripts: not taken");
    assert.equal(sniffChatFile("app.exe", bytes("MZ")), null);
    assert.equal(sniffChatFile("fake.txt", bytes("ab", [0], "cd")), null, "a binary renamed .txt");
    assert.equal(sniffChatFile("bad.txt", bytes([0xc3, 0x28])), null, "not UTF-8");
  });

  it("keeps a safe file name", () => {
    assert.equal(chatFileName("../../etc/passwd"), "passwd");
    assert.equal(chatFileName("C:\\Users\\a\\ảnh chụp.png"), "ảnh chụp.png");
    assert.equal(chatFileName(".env"), "env", "no hidden file on the machine");
    assert.equal(chatFileName("a\u202Egnp.exe"), "agnp.exe", "no right-to-left trick");
    assert.equal(chatFileName(""), "file");
    assert.equal(chatFileName(`${"x".repeat(200)}.png`).length, 120);
    assert.ok(chatFileName(`${"x".repeat(200)}.png`).endsWith(".png"), "the end, with the extension, is kept");
  });

  it("takes files from the project's managers, sends them with a message, and shows them to whoever sees the chat", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", projects: ["app"], acceptsRuns: true, profiles: [
      { id: "claude-1", label: "claude-1", kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 },
    ] }, mbp);
    const shot = hive.putChatFile({ project: "app", name: "login error.png", bytes: PNG }, lead);
    assert.deepEqual([shot.name, shot.type, shot.size], ["login error.png", "image/png", PNG.length]);
    const log = hive.putChatFile({ project: "app", name: "run.log", bytes: bytes("exit 1\n") }, lead);

    // Before it is sent, nobody but whoever uploaded it sees it, and nobody else can send it.
    assert.equal(hive.chatFile(shot.id, other), null);
    assert.ok(hive.chatFile(shot.id, lead));
    assert.equal(await refusal(() => hive.call("chat.send", { project: "app", machineId: mbp.name, text: "see", files: [shot.id] }, other)), "errors.chatFileNotFound");

    const sent = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Why does login fail?", files: [shot.id, log.id] }, lead);
    assert.deepEqual(sent.message.files.map((f) => f.name), ["login error.png", "run.log"]);
    const [message] = (await hive.call("chat.get", { threadId: sent.thread.id }, reader))!.messages;
    assert.deepEqual(message!.files.map((f) => [f.id, f.type]), [[shot.id, "image/png"], [log.id, "text/plain"]]);
    assert.deepEqual([...hive.chatFile(shot.id, reader)!.bytes], [...PNG], "a viewer of the project reads it");
    assert.ok(hive.chatFile(log.id, mbp), "the machine that writes the reply reads it");
    const [request] = await hive.call("chat.poll", {}, mbp);
    assert.deepEqual(request!.files?.map((f) => [f.id, f.name]), [[shot.id, "login error.png"], [log.id, "run.log"]], "the machine hears which files to fetch");
    assert.equal(hive.chatFile(shot.id, outsider), null, "not outside the project");

    // Sent once only, and gone with its thread.
    await hive.call("chat.finish", { replyId: sent.reply.id, status: "done", text: "Seen." }, mbp);
    assert.equal(await refusal(() => hive.call("chat.send", { project: "app", threadId: sent.thread.id, text: "again", files: [shot.id] }, lead)), "errors.chatFileNotFound");
    await hive.call("chat.delete", { threadId: sent.thread.id }, lead);
    assert.equal(hive.chatFile(shot.id, admin), null);
  });

  it("refuses what the hub does not keep", async () => {
    const hive = new SqliteHive(":memory:");
    assert.equal(await refusal(() => hive.putChatFile({ project: "app", name: "x.png", bytes: PNG }, reader)), "errors.need.manage");
    assert.equal(await refusal(() => hive.putChatFile({ project: "app", name: "x.png", bytes: PNG }, outsider)), "errors.notFound");
    assert.equal(await refusal(() => hive.putChatFile({ project: "app", name: "empty.txt", bytes: new Uint8Array() }, lead)), "errors.chatFileEmpty");
    assert.equal(await refusal(() => hive.putChatFile({ project: "app", name: "big.png", bytes: new Uint8Array(5 * 1024 * 1024 + 1) }, lead)), "errors.chatFileTooBig");
    assert.equal(await refusal(() => hive.putChatFile({ project: "app", name: "page.html", bytes: bytes("<b>") }, lead)), "errors.chatFileType");
    const secret = `token ghp_${"a".repeat(36)}\n`;
    assert.equal(await refusal(() => hive.putChatFile({ project: "app", name: "env.txt", bytes: bytes(secret) }, lead)), "errors.secret");
  });
});
