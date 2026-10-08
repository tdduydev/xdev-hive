import assert from "node:assert/strict";
import { it } from "node:test";
import { createHttpClient } from "#ui/client.ts";
import { TerminalConnection, terminalChunks, terminalPasteChunks, encodeTerminal, decodeTerminal, pasteDisplay, terminalSecure, terminalSocketUrl } from "#ui/lib/terminal-client.ts";

class Socket {
  readyState = 1;
  bufferedAmount = 0;
  frames: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(text: string) { this.frames.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

it("terminal is absent for bearer clients and present only for cookie HTTP clients", () => {
  assert.equal(createHttpClient({ token: "synthetic" }).terminal, undefined);
  assert.ok(createHttpClient().terminal);
});

it("socket uses same-origin WSS, with no ticket in URL; plaintext LAN is refused", () => {
  assert.equal(terminalSocketUrl("https://hive.example/a"), "wss://hive.example/api/terminal/socket");
  assert.equal(terminalSocketUrl("http://127.0.0.1:7780/"), "ws://127.0.0.1:7780/api/terminal/socket");
  assert.throws(() => terminalSocketUrl("http://10.86.140.52:7780/"));
  assert.equal(terminalSecure(new URL("http://localhost.evil/")), false);
});

it("UTF-8 chunking preserves Telex/VNI results, combining accents and emoji without normalization", () => {
  const text = "Tiếng Việt: a\u0306\u0301 ắ Đ đ 😀\r\n".repeat(3000);
  const chunks = terminalChunks(text);
  assert.equal(chunks.join(""), text);
  for (const chunk of chunks) {
    assert.ok(new TextEncoder().encode(chunk).length <= 16 * 1024);
    assert.equal(new TextDecoder().decode(decodeTerminal(encodeTerminal(chunk))), chunk);
  }
  assert.equal(pasteDisplay("echo a\r\n\x03\t"), "echo a␍↵\n\\x03⇥");
});

it("input is gated by active state, never queued/retried; reconnect uses new epoch starting at 1", () => {
  const c = new TerminalConnection({ output: (_bytes, done) => done(), status: () => undefined, gap: () => undefined });
  const first = new Socket();
  c.connect(first as unknown as WebSocket, "synthetic-ticket", 0); first.onopen?.();
  assert.deepEqual(first.frames, [{ type: "auth", ticket: "synthetic-ticket" }]);
  assert.equal(c.input("not active"), false);
  first.receive({ type: "state", state: "active" });
  assert.equal(c.input("one"), true);
  first.close(); assert.equal(c.input("disconnected"), false);
  const second = new Socket(); c.connect(second as unknown as WebSocket, "second-ticket", 1); second.onopen?.();
  second.receive({ type: "state", state: "active" });
  assert.equal(c.input("two"), true);
  assert.deepEqual(second.frames.filter(f => f.type === "input"), [{ type: "input", epoch: 1, inputSeq: 1, data: encodeTerminal("two") }]);
  second.bufferedAmount = 20_000; assert.equal(c.input("full"), false);
  second.bufferedAmount = 0; assert.equal(c.input("three"), true);
  assert.equal(second.frames.at(-1).inputSeq, 2);
  c.detach();
});

it("large paste keeps one Enter for CRLF across frame boundaries, including bracket overhead", () => {
  const prefix = "a".repeat(12 * 1024 - 1);
  const chunks = terminalPasteChunks(`${prefix}\r\nTiếng Việt a\u0306\u0301\n`);
  assert.equal(chunks.join(""), `${prefix}\rTiếng Việt a\u0306\u0301\r`);
  for (const chunk of chunks) assert.ok(new TextEncoder().encode(`\x1b[200~${chunk}\x1b[201~`).length <= 16 * 1024);
});

it("output dedups, checks sequence, and ACKs only after rendering; gap resets pointer", () => {
  const rendered: Array<() => void> = [];
  const received: string[] = [];
  let gaps = 0;
  const c = new TerminalConnection({ output: (bytes, done) => { received.push(new TextDecoder().decode(bytes)); rendered.push(done); }, status: () => undefined, gap: () => gaps++ });
  const socket = new Socket(); c.connect(socket as unknown as WebSocket, "ticket", 3); socket.onopen?.(); socket.receive({ type: "state", state: "active" });
  const output = (seq: number) => socket.receive({ type: "output", epoch: 3, outputSeq: seq, data: encodeTerminal(`out-${seq}`) });
  output(1); output(1);
  assert.deepEqual(received, ["out-1"]); assert.equal(c.lastOutputSeq, 0);
  assert.ok(socket.frames.filter(f => f.type === "ack").every(f => f.outputSeq === 0));
  rendered.shift()!(); assert.equal(c.lastOutputSeq, 1);
  socket.receive({ type: "gap", firstAvailableSeq: 5 }); output(5); rendered.shift()!();
  assert.equal(gaps, 1); assert.equal(c.lastOutputSeq, 5);
  output(7); assert.equal(socket.readyState, 3);
  c.detach();
});

it("reconnect while xterm renders a queued output does not paint the replay twice", () => {
  const pending: Array<() => void> = [];
  let writes = 0;
  const c = new TerminalConnection({ output: (_bytes, done) => { writes++; pending.push(done); }, status: () => undefined, gap: () => undefined });
  const first = new Socket(); c.connect(first as unknown as WebSocket, "ticket", 0); first.onopen?.(); first.receive({ type: "state", state: "active" });
  first.receive({ type: "output", epoch: 0, outputSeq: 1, data: encodeTerminal("queued") });
  first.close();
  const next = new Socket(); c.connect(next as unknown as WebSocket, "next", 1); next.onopen?.(); next.receive({ type: "state", state: "active" });
  next.receive({ type: "output", epoch: 1, outputSeq: 1, data: encodeTerminal("queued") });
  assert.equal(writes, 1); assert.equal(c.lastOutputSeq, 0);
  pending.shift()!();
  assert.equal(c.lastOutputSeq, 1); assert.deepEqual(next.frames.at(-1), { type: "ack", outputSeq: 1 });
  c.detach();
});

it("replacing a socket invalidates paced paste and never authenticates a late old socket", () => {
  const c = new TerminalConnection({ output: (_bytes, done) => done(), status: () => undefined, gap: () => undefined });
  const old = new Socket(); c.connect(old as unknown as WebSocket, "old-ticket", 0);
  const generation = c.generation;
  const next = new Socket(); c.connect(next as unknown as WebSocket, "new-ticket", 1);
  old.onopen?.();
  assert.deepEqual(old.frames, []);
  next.onopen?.(); next.receive({ type: "state", state: "active" });
  assert.equal(c.writable, true);
  assert.notEqual(c.generation, generation);
  assert.deepEqual(next.frames, [{ type: "auth", ticket: "new-ticket" }, { type: "ack", outputSeq: 0 }]);
  c.detach();
});
