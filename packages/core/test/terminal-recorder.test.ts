import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  SqliteHive, TerminalStore, TerminalRedactor, TerminalRecorder, TerminalRecorderError, TerminalRecordingStore, TerminalTranscriptTampered,
  loadTerminalKey, purgeTerminalSpools, readTerminalTranscript, terminalRecorderReady, terminalRecordingChunks, terminalRecordingChunkSchema,
  type Actor, type TerminalCapability, type TerminalMachineIdentity, type RecorderIo,
} from "#core/node.ts";

// Synthetic canaries only (spec §8): built at run time so no scanner mistakes this file for a leak.
const GH = "gh" + "p_" + "CANARYcanary0123456789abcdefghijklmnop";
const PROFILE = "profile-secret-" + "value-42";
const TYPED = "typed-password-" + "hunter2";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
/** The redactor fed one byte at a time: every possible chunk boundary at once. */
const byteByByte = (r: TerminalRedactor, s: string) => [...bytes(s)].map((b) => r.write(Uint8Array.of(b))).join("") + r.end();

const temp = () => mkdtempSync(path.join(tmpdir(), "hive-recorder-"));
const sid = () => crypto.randomUUID();
/** Every byte under dir, so a test can say a canary is nowhere on disk. */
const disk = (dir: string): Buffer => Buffer.concat(readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => readFileSync(path.join(e.parentPath, e.name))));

function setup() {
  const dir = temp();
  const root = path.join(dir, "spool");
  const master = loadTerminalKey(path.join(dir, "terminal.key"));
  return { dir, root, master, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("69d transcript redactor", () => {
  it("hides a known pattern split at every byte, through colour codes and backspaces", () => {
    const out = byteByByte(new TerminalRedactor(), `ok line\r\ntoken: ${GH.slice(0, 9)}\x1b[1;31m${GH.slice(9)}\x1b[0m\r\nX\bnext\n`);
    assert.ok(!out.includes(GH.slice(4)), out);
    assert.match(out, /^ok line\n\(line hidden: it looked like a GitHub token\)\nnext\n$/);
    const typo = new TerminalRedactor();
    assert.ok(!byteByByte(typo, `${GH.slice(0, 20)}Z\b${GH.slice(20)}\n`).includes("CANARY"), "a typo fixed while typing still matches");
  });

  it("hides the profile's own secret values and keeps split UTF-8 intact", () => {
    const r = new TerminalRedactor([PROFILE]);
    const out = byteByByte(r, `Tiếng Việt có dấu ✓\nexport X=${PROFILE}\nall fine\n`);
    assert.equal(out, "Tiếng Việt có dấu ✓\n(line hidden: it looked like a known secret)\nall fine\n");
  });

  it("hides known values of any length, and each line of one with line breaks", () => {
    const note = "(line hidden: it looked like a known secret)\n";
    const short = new TerminalRedactor(["q7", "", "  "]);
    assert.equal(byteByByte(short, "pin q7 ok\nnothing here\n"), `${note}nothing here\n`, "short values are hidden too; blank ones match nothing");
    const multi = new TerminalRedactor(["first-half-of-it\r\nsecond-half-of-it"]);
    assert.equal(byteByByte(multi, "a first-half-of-it\nb second-half-of-it\nc\n"), `${note}${note}c\n`);
    // Longer than the tail kept of a long line: it must still be seen whole before any of it is let out.
    const long = "L0ng" + "abcdef0123456789".repeat(130);
    const out = byteByByte(new TerminalRedactor([long]), `${"a".repeat(9000)}${long}${"b".repeat(9000)}\nafter\n`);
    assert.ok(!out.includes(long.slice(0, 40)) && !out.includes("abcdef0123456789"), "no part of it leaves");
    assert.ok(out.includes(note) && out.endsWith("after\n"));
  });

  it("drops OSC strings (clipboard writes, titles) whole", () => {
    const out = byteByByte(new TerminalRedactor(), `a\x1b]52;c;${Buffer.from(GH).toString("base64")}\x07b\x1b]0;${GH}\x1b\\c\n`);
    assert.equal(out, "abc\n");
  });

  it("hides every line of a private key block", () => {
    const out = byteByByte(new TerminalRedactor(), "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecretbody\n-----END OPENSSH PRIVATE KEY-----\nafter\n");
    assert.ok(!out.includes("AAAAsecretbody"));
    assert.match(out, /^before\n(\(line hidden: it looked like a private key\)\n){3}after\n$/);
  });

  it("keeps hiding a private key whose BEGIN line was too long to hold", () => {
    const begin = "-----BEGIN RSA PRIVATE KEY-----";
    const rest = "\nKEYBODYsecret1\nKEYBODYsecret2\n-----END RSA PRIVATE KEY-----\nafter\n";
    for (const line of [`${"x".repeat(8000)}${begin}${"y".repeat(500)}`, `${begin}${"z".repeat(9000)}`]) {
      const out = byteByByte(new TerminalRedactor(), line + rest);
      assert.ok(!out.includes("KEYBODY"), out.slice(-300));
      assert.ok(out.endsWith("(line hidden: it looked like a private key)\nafter\n"));
    }
  });

  it("bounds a line that never ends and still hides a secret in it", () => {
    const r = new TerminalRedactor();
    let out = "";
    for (let i = 0; i < 64; i++) out += r.write(bytes("x ".repeat(500)));
    assert.ok(out.length > 50_000, "a progress bar without newline is let out as it comes");
    out += r.write(bytes(GH.slice(0, 10)));
    out += r.write(bytes(GH.slice(10) + " y".repeat(10_000)));
    out += r.write(bytes("tail\nvisible\n")) + r.end();
    assert.ok(!out.includes("CANARY"), "neither the prefix nor the body leaves");
    assert.ok(out.includes("(line hidden: it looked like a GitHub token)\n"));
    assert.ok(out.endsWith("visible\n"));
  });
});

describe("69d encrypted spool", () => {
  it("records a session without any canary on disk, input only as a byte count", () => {
    const { root, master, done } = setup();
    const id = sid();
    const rec = TerminalRecorder.open({ root, sessionId: id, master, known: [PROFILE] });
    rec.spawn(80, 24);
    rec.output(bytes("$ "));
    rec.input(Buffer.byteLength(TYPED + "\r"));
    rec.output(bytes(`Password: \r\nhello ${GH}\r\n`));
    rec.resize(100, 30);
    rec.output(bytes(`PROFILE=${PROFILE}\r\nbye`));
    rec.close("exited", 0);
    rec.close("exited", 0);

    assert.equal(statSync(path.join(root, id)).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(root, id, "archive.bin")).mode & 0o777, 0o600);
    const raw = disk(root);
    for (const canary of [GH, PROFILE, TYPED, "hello", "Password"]) assert.equal(raw.indexOf(canary), -1, `${canary} is encrypted or absent`);

    const t = readTerminalTranscript(root, id, master);
    assert.equal(t.torn, false);
    assert.deepEqual(t.events.map((e) => e.type), ["spawn", "sensitive-input", "output", "resize", "output", "output", "close"]);
    const text = t.events.flatMap((e) => (e.type === "output" ? [e.text] : [])).join("");
    assert.equal(text, "$ Password: \n(line hidden: it looked like a GitHub token)\n(line hidden: it looked like a known secret)\nbye");
    assert.ok(!JSON.stringify(t).includes(TYPED));
    // "$ " has no newline yet: a partial line waits until it can be judged whole.
    assert.deepEqual(t.events[1], { seq: 3, at: t.events[1]!.at, type: "sensitive-input", bytes: TYPED.length + 1 });
    assert.deepEqual(t.head, rec.anchors().transcript);
    assert.throws(() => rec.output(bytes("late")), (e: TerminalRecorderError) => e.failure === "closed");
    done();
  });

  it("does not read the raw archive, nor a spool someone edited", () => {
    const { dir, root, master, done } = setup();
    const id = sid();
    const rec = TerminalRecorder.open({ root, sessionId: id, master });
    rec.spawn(80, 24);
    rec.output(bytes("one\ntwo\n"));
    rec.close("exited", 0);
    const file = path.join(root, id, "transcript.bin");
    const good = readFileSync(file);

    // The archive under the transcript's name: another key, so it does not open.
    writeFileSync(file, readFileSync(path.join(root, id, "archive.bin")));
    assert.throws(() => readTerminalTranscript(root, id, master), TerminalTranscriptTampered);
    const flipped = Buffer.from(good);
    flipped[40]! ^= 1;
    writeFileSync(file, flipped);
    assert.throws(() => readTerminalTranscript(root, id, master), TerminalTranscriptTampered);
    // Dropping the first frame: the next one carries frame number 2 in its associated data.
    writeFileSync(file, good.subarray(4 + good.readUInt32BE(0)));
    assert.throws(() => readTerminalTranscript(root, id, master), TerminalTranscriptTampered);
    // A frame cut short (crash mid-write) reads up to the last whole event.
    writeFileSync(file, good.subarray(0, good.length - 3));
    const torn = readTerminalTranscript(root, id, master);
    assert.equal(torn.torn, true);
    assert.deepEqual(torn.events.map((e) => e.type), ["spawn", "output"]);
    assert.throws(() => readTerminalTranscript(root, id, loadTerminalKey(path.join(dir, "other.key"))), TerminalTranscriptTampered);
    assert.throws(() => readTerminalTranscript(root, "../x", master), TerminalTranscriptTampered);
    done();
  });

  it("fails closed when the disk fills, keeping what was written readable", () => {
    const { root, master, done } = setup();
    const id = sid();
    let budget = Infinity;
    const io: RecorderIo = {
      writeSync: (fd, data) => {
        if (budget <= 0) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        // Half of what fits, then ENOSPC: the torn frame must be cut off again.
        const n = Math.min(data.length, Math.max(1, Math.floor(budget / 2)));
        budget -= n;
        return writeSync(fd, data.subarray(0, n));
      },
      fsyncSync: () => {},
    };
    const rec = TerminalRecorder.open({ root, sessionId: id, master, io });
    rec.spawn(80, 24);
    rec.output(bytes("kept\n"));
    budget = 30;
    assert.throws(() => rec.input(5), (e: TerminalRecorderError) => e.failure === "diskFull");
    assert.equal(rec.failed, "diskFull");
    assert.throws(() => rec.output(bytes("after")), (e: TerminalRecorderError) => e.failure === "diskFull", "nothing runs unrecorded");
    rec.close("auditFailed");
    const t = readTerminalTranscript(root, id, master);
    assert.equal(t.torn, false, "the half frame was truncated");
    assert.deepEqual(t.events.map((e) => (e.type === "output" ? e.text : e.type)), ["spawn", "kept\n"]);
    done();
  });

  it("stops at the quota but still records why the session ended", () => {
    const { root, master, done } = setup();
    const id = sid();
    const rec = TerminalRecorder.open({ root, sessionId: id, master, quotaBytes: 4096 + 2000 });
    rec.spawn(80, 24);
    assert.throws(() => { for (let i = 0; i < 100; i++) rec.output(bytes("y".repeat(100) + "\n")); }, (e: TerminalRecorderError) => e.failure === "quota");
    assert.throws(() => rec.input(1), (e: TerminalRecorderError) => e.failure === "quota");
    rec.close("auditFailed");
    const last = readTerminalTranscript(root, id, master).events.at(-1);
    assert.equal(last?.type === "close" && last.reason, "auditFailed");
    done();
  });

  it("writes the close event at the quota even when a long unfinished line is held back", () => {
    const { root, master, done } = setup();
    const id = sid();
    const rec = TerminalRecorder.open({ root, sessionId: id, master, quotaBytes: 4096 + 20_000 });
    rec.spawn(80, 24);
    // No newline: the redactor holds it, and at close it is bigger than the whole reserve.
    rec.output(bytes("h".repeat(4500)));
    assert.throws(() => { for (;;) rec.input(1); }, (e: TerminalRecorderError) => e.failure === "quota");
    rec.close("auditFailed");
    const events = readTerminalTranscript(root, id, master).events;
    const last = events.at(-1);
    assert.equal(last?.type === "close" && last.reason, "auditFailed");
    done();
  });

  it("refuses to open when the spool, the key or the session id is not right", () => {
    const { dir, root, master, done } = setup();
    assert.equal(terminalRecorderReady(root, master), null);
    chmodSync(root, 0o770);
    assert.equal(terminalRecorderReady(root, master), "notReady");
    assert.throws(() => TerminalRecorder.open({ root, sessionId: sid(), master }), (e: TerminalRecorderError) => e.failure === "notReady");
    chmodSync(root, 0o700);
    assert.equal(terminalRecorderReady(root, Buffer.alloc(5)), "cryptoFailed");
    assert.throws(() => TerminalRecorder.open({ root, sessionId: "../../etc", master }), TerminalRecorderError);
    const id = sid();
    TerminalRecorder.open({ root, sessionId: id, master }).close("exited");
    assert.throws(() => TerminalRecorder.open({ root, sessionId: id, master }), TerminalRecorderError, "a spool is never reopened");

    const keyFile = path.join(dir, "terminal.key");
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.deepEqual(loadTerminalKey(keyFile), master, "the same key on the next start");
    chmodSync(keyFile, 0o644);
    assert.throws(() => loadTerminalKey(keyFile), TerminalRecorderError);
    chmodSync(keyFile, 0o600);
    symlinkSync(keyFile, path.join(dir, "link.key"));
    assert.throws(() => loadTerminalKey(path.join(dir, "link.key")), TerminalRecorderError);
    writeFileSync(path.join(dir, "short.key"), "x", { mode: 0o600 });
    assert.throws(() => loadTerminalKey(path.join(dir, "short.key")), TerminalRecorderError);
    done();
  });

  it("purges spools past retention and nothing else", () => {
    const { root, master, done } = setup();
    const old = sid();
    const fresh = sid();
    TerminalRecorder.open({ root, sessionId: old, master }).close("exited");
    TerminalRecorder.open({ root, sessionId: fresh, master }).close("exited");
    mkdirSync(path.join(root, "not-a-session"));
    const now = new Date();
    const past = new Date(now.getTime() - 31 * 86_400_000);
    for (const f of ["", "archive.bin", "transcript.bin"]) utimesSync(path.join(root, old, f), past, past);
    utimesSync(path.join(root, "not-a-session"), past, past);
    assert.deepEqual(purgeTerminalSpools(root, now), [old]);
    assert.deepEqual(readdirSync(root).sort(), [fresh, "not-a-session"].sort());
    done();
  });
});

describe("69d hub recording store", () => {
  const cap: TerminalCapability = { protocol: 1, enabled: true, projects: ["app"], platforms: ["darwin"], auditReady: true, guiReady: true };
  const web = { via: "web" } as const;
  const person = (account: string, extra: Partial<Actor> = {}): Actor =>
    ({ name: account, role: "member", account, source: web, humanSession: `s-${account}`, access: { projects: { app: "member" } }, ...extra });
  const runner: Actor = { name: "runner.mini@mini", role: "agent", account: "owner" };
  /**
   * SEC-machine-identity as the hub will give it: holding the paired token (here: being that very actor object, as a
   * token id would be) and the owner pinned with it, whatever a later heartbeat wrote into machines.owner.
   */
  const identity: TerminalMachineIdentity = {
    isMachineActor: (machineId, actor) => machineId === runner.name && actor === runner,
    pinnedOwner: (machineId) => (machineId === runner.name ? "owner" : null),
  };

  async function hub() {
    const dir = temp();
    const h = new SqliteHive(":memory:");
    let now = new Date("2026-10-08T00:00:00.000Z");
    await h.call("machines.heartbeat", { machine: "mini", instance: "aaaaaaaa", terminal: cap } as never, runner);
    const sessions = new TerminalStore(h.db, () => now);
    const s = sessions.create({ project: "app", machineId: runner.name, creator: "alice", browserSession: "b", checkoutRef: "repo", reason: "", idempotencyKey: sid() });
    const master = loadTerminalKey(path.join(dir, "recording.key"));
    const store = new TerminalRecordingStore(h.db, path.join(dir, "recordings"), master, () => now, identity);
    return { dir, h, s, sessions, store, master, tick: (days: number) => { now = new Date(now.getTime() + days * 86_400_000); },
      done: () => { h.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  /** A real spool's transcript, chunked as the machine would upload it. */
  function machineChunks(sessionId: string, lines: string[]) {
    const { root, master, done } = setup();
    const rec = TerminalRecorder.open({ root, sessionId, master });
    rec.spawn(80, 24);
    for (const l of lines) rec.output(bytes(l + "\r\n"));
    rec.close("exited", 0);
    const t = readTerminalTranscript(root, sessionId, master);
    done();
    return t.events;
  }

  it("stores chained chunks from the session's machine only, idempotently", async () => {
    const { s, store, done } = await hub();
    const events = machineChunks(s.id, ["one", "two"]);
    const [a] = terminalRecordingChunks(events.slice(0, 2));
    const [b] = terminalRecordingChunks(events.slice(2), { seq: 1, hash: a!.hash });
    assert.throws(() => store.put(person("alice"), s.id, a), { code: "forbidden" }, "a person cannot upload");
    assert.throws(() => store.put({ ...runner, name: "runner.other@x" }, s.id, a), { code: "forbidden" }, "another machine");
    assert.throws(() => store.put(runner, s.id, b), { code: "conflict" }, "a chunk that does not follow the last");
    assert.equal(store.put(runner, s.id, a), "stored");
    assert.equal(store.put(runner, s.id, a), "duplicate");
    assert.throws(() => store.put(runner, s.id, { ...a!, events: a!.events.slice(1) }), { code: "bad_request" }, "hash must match");
    assert.equal(store.put(runner, s.id, b), "stored");
    done();
  });

  it("has no field for raw output", () => {
    const raw = { seq: 1, prevHash: "0".repeat(64), hash: "0".repeat(64), events: [{ seq: 1, at: "x", type: "output", data: "aGk=" }] };
    assert.equal(terminalRecordingChunkSchema.safeParse(raw).success, false);
    const extra = { seq: 1, prevHash: "0".repeat(64), hash: "0".repeat(64), archive: "x", events: [{ seq: 1, at: "x", type: "spawn", cols: 1, rows: 1 }] };
    assert.equal(terminalRecordingChunkSchema.safeParse(extra).success, false);
  });

  it("serves the transcript only under the recording rule, audits each read, keeps it encrypted", async () => {
    const { h, s, store, dir, done } = await hub();
    // An old app that did not filter: the hub hides the line again.
    const events = [{ seq: 1, at: "2026-10-08T00:00:00.000Z", type: "output" as const, text: `leak ${GH}\nfine\n` }];
    const [chunk] = terminalRecordingChunks(events);
    store.put(runner, s.id, chunk);
    assert.equal(disk(path.join(dir, "recordings")).indexOf("fine"), -1, "encrypted at rest");
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM terminal_audit_chunks WHERE storage_ref LIKE '%fine%' OR hash = 'fine'").get() as { n: number }).n, 0);

    const read = (actor: Actor, stepUp = true) => store.read(actor, { project: "app", sessionId: s.id, hubEnabled: false, stepUp });
    const page = read(person("alice"));
    assert.deepEqual(page.events.map((e) => e.type === "output" && e.text), ["(line hidden: it looked like a GitHub token)\nfine\n"]);
    assert.equal(page.hubRedacted, 1);
    assert.equal(page.next, null);
    assert.ok(read(person("owner")).events.length, "the machine's owner");
    assert.ok(read(person("root", { role: "admin", access: undefined })).events.length, "a hub admin, even with the feature switched off");
    assert.throws(() => read(person("alice"), false), { code: "forbidden" }, "step-up first");
    assert.throws(() => read(person("mallory")), { code: "forbidden" });
    assert.throws(() => read(person("alice", { access: { projects: { other: "lead" } } })), { code: "not_found" });
    assert.throws(() => read({ ...person("alice"), humanSession: undefined }), { code: "forbidden" }, "no bearer");
    assert.throws(() => read(runner), { code: "forbidden" }, "the machine uploads, it does not read back");
    const audit = h.db.prepare("SELECT actor, detail FROM audit WHERE action = 'terminal.recording.view' ORDER BY id").all() as { actor: string; detail: string }[];
    assert.equal(audit.length, 8);
    assert.deepEqual(audit.filter((a) => a.detail === "denied").map((a) => a.actor), ["alice", "mallory", "alice", "alice", "runner.mini@mini"]);

    const ref = (h.db.prepare("SELECT storage_ref FROM terminal_audit_chunks WHERE session_id = ?").get(s.id) as { storage_ref: string }).storage_ref;
    const file = path.join(dir, "recordings", ref);
    const bad = readFileSync(file);
    bad[bad.length - 1]! ^= 1;
    writeFileSync(file, bad);
    assert.throws(() => read(person("alice")), { code: "conflict" });
    rmSync(file);
    assert.throws(() => read(person("alice")), { code: "conflict" }, "a missing file is reported the same way");
    const failed = h.db.prepare("SELECT actor, detail FROM audit WHERE action = 'terminal.recording.view' AND detail LIKE 'failed%'").all();
    assert.deepEqual(failed.map((a) => ({ ...a })), [{ actor: "alice", detail: "failed cursor=0" }, { actor: "alice", detail: "failed cursor=0" }],
      "an allowed read that fails is audited too");
    done();
  });

  it("trusts the machine's pinned credential, not its name or the owner a heartbeat wrote", async () => {
    const { h, s, store, dir, master, done } = await hub();
    const [a] = terminalRecordingChunks(machineChunks(s.id, ["one"]));
    // Another account heartbeats under the same machine name: the row's owner becomes theirs.
    h.db.prepare("UPDATE machines SET owner = 'mallory' WHERE id = ?").run(runner.name);
    assert.throws(() => store.put({ ...runner, account: "mallory" }, s.id, a), { code: "forbidden" }, "the same name, another account");
    assert.throws(() => store.put({ ...runner }, s.id, a), { code: "forbidden" }, "the same name and account, not the paired token");
    assert.equal(store.put(runner, s.id, a), "stored");
    const read = (st: TerminalRecordingStore, actor: Actor) => st.read(actor, { project: "app", sessionId: s.id, hubEnabled: true, stepUp: true });
    assert.throws(() => read(store, person("mallory")), { code: "forbidden" }, "the heartbeat's owner reads nothing");
    assert.ok(read(store, person("owner")).events.length, "the pinned owner does");

    // A hub without the pinned identity: nothing is uploaded and the machine's owner gets no reads, creator and admins do.
    const bare = new TerminalRecordingStore(h.db, path.join(dir, "recordings"), master, () => new Date());
    assert.throws(() => bare.put(runner, s.id, a), { code: "forbidden" });
    assert.throws(() => read(bare, person("owner")), { code: "forbidden" });
    assert.ok(read(bare, person("alice")).events.length);
    done();
  });

  it("filters the session as one stream: a secret split across events or chunks is still hidden", async () => {
    const { s, store, done } = await hub();
    const at = "2026-10-08T00:00:00.000Z";
    const out = (seq: number, text: string) => ({ seq, at, type: "output" as const, text });
    // What an old or broken app might upload: nothing filtered, events cut anywhere.
    const [a] = terminalRecordingChunks([out(1, `token ${GH.slice(0, 12)}`), out(2, `${GH.slice(12)} end\n-----BEGIN RSA PRIVATE KEY-----\n`)]);
    const [b] = terminalRecordingChunks([
      out(3, "KEYBODYsecret1\n"), out(4, "KEYBODYsecret2\n-----END RSA PRIVATE KEY-----\nvisible "),
      { seq: 5, at, type: "close", reason: "exited", exitCode: 0 },
    ], { seq: 1, hash: a!.hash });
    store.put(runner, s.id, a);
    store.put(runner, s.id, b);
    const page = store.read(person("alice"), { project: "app", sessionId: s.id, hubEnabled: true, stepUp: true });
    const text = page.events.flatMap((e) => (e.type === "output" ? [e.text] : [])).join("");
    assert.ok(!text.includes(GH.slice(4, 16)) && !text.includes("KEYBODY"), text);
    assert.equal(text, "(line hidden: it looked like a GitHub token)\n" + "(line hidden: it looked like a private key)\n".repeat(4) + "visible ");
    assert.equal(page.events.at(-1)?.type, "close");
    assert.equal(page.hubRedacted, 5);
    done();
  });

  it("leaves no file behind when an upload fails, and purges by directory", async () => {
    const { h, s, sessions, store, dir, tick, done } = await hub();
    const recordings = path.join(dir, "recordings");
    const [a] = terminalRecordingChunks(machineChunks(s.id, ["one"]));
    h.db.exec("CREATE TRIGGER chunk_fails BEFORE INSERT ON terminal_audit_chunks BEGIN SELECT RAISE(ABORT, 'row not written'); END");
    assert.throws(() => store.put(runner, s.id, a));
    assert.deepEqual(readdirSync(path.join(recordings, s.id)), [], "the file of a chunk without a row is removed");
    h.db.exec("DROP TRIGGER chunk_fails");
    // A crash between file and row, and the directory of a session the hub no longer has.
    writeFileSync(path.join(recordings, s.id, "1-crashed.bin"), "x");
    const gone = sid();
    mkdirSync(path.join(recordings, gone));
    mkdirSync(path.join(recordings, "not-a-session"));
    assert.deepEqual(store.purge(), [gone], "a live session keeps its files");
    sessions.transition(s.id, s.version, "closed", "userClosed");
    tick(31);
    assert.deepEqual(store.purge(), [s.id], "no row needed to find what to delete");
    assert.deepEqual(readdirSync(recordings), ["not-a-session"]);
    done();
  });

  it("pages long recordings and purges them after retention", async () => {
    const { h, s, sessions, store, dir, tick, done } = await hub();
    const events = Array.from({ length: 40 }, (_, i) => ({ seq: i + 1, at: "t", type: "output" as const, text: "z".repeat(60_000) + "\n" }));
    const chunks = terminalRecordingChunks(events);
    assert.ok(chunks.length > 8);
    for (const c of chunks) store.put(runner, s.id, c);
    let cursor = 0;
    let seen = 0;
    for (;;) {
      const page = store.read(person("alice"), { project: "app", sessionId: s.id, cursor, hubEnabled: true, stepUp: true });
      seen += page.events.length;
      if (page.next === null) break;
      cursor = page.next;
    }
    assert.equal(seen, 40);

    assert.deepEqual(store.purge(), [], "a live session is kept");
    sessions.transition(s.id, s.version, "closed", "userClosed");
    tick(29);
    assert.deepEqual(store.purge(), []);
    tick(2);
    assert.deepEqual(store.purge(), [s.id]);
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM terminal_audit_chunks").get() as { n: number }).n, 0);
    assert.deepEqual(readdirSync(path.join(dir, "recordings")), []);
    done();
  });
});
