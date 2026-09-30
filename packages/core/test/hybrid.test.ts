import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { fuseRanks, normalize, openAiEmbedder, similarity, type Actor, type Embedder } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const claude: Actor = { name: "claude@duy", role: "agent" };

// Words of one meaning share a dimension, so "triển khai" and "deploy" come out alike; the rest share one.
const CONCEPTS = [
  ["deploy", "triển", "khai", "release", "phát", "hành"],
  ["database", "sqlite", "migration", "dữ", "liệu"],
  ["test", "kiểm", "thử", "node:test"],
];
function fakeEmbedder(model = "fake-1", fail = false): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model,
    calls,
    async embed(texts) {
      calls.push(texts);
      if (fail) throw new Error("HTTP 500");
      return texts.map((t) => {
        const v = new Float32Array(CONCEPTS.length + 1);
        for (const w of t.toLowerCase().split(/[^\p{L}\p{N}:]+/u).filter(Boolean)) {
          const i = CONCEPTS.findIndex((c) => c.includes(w));
          v[i === -1 ? CONCEPTS.length : i]! += i === -1 ? 0.2 : 1;
        }
        return normalize(v);
      });
    },
  };
}

const write = (hive: SqliteHive, content: string, project = "app", actor: Actor = admin) =>
  hive.call("memory.write", { project, kind: "decision", content }, actor);
const found = async (hive: SqliteHive, query: string, project = "app") =>
  (await hive.call("memory.search", { project, query }, claude)).map((m) => m.content);

describe("hybrid memory search", () => {
  it("fuses ranks: first in either list or in both comes first", () => {
    assert.deepEqual(fuseRanks([[1, 2, 3], [3, 4]]), [3, 1, 2, 4]);
    assert.deepEqual(fuseRanks([[], [7, 8]]), [7, 8]);
    assert.ok(Math.abs(similarity(normalize(Float32Array.of(3, 4)), normalize(Float32Array.of(6, 8))) - 1) < 1e-6);
  });

  it("finds entries by meaning once they are indexed, next to what matches the words", async () => {
    const embedder = fakeEmbedder();
    const hive = new SqliteHive(":memory:", { embedder });
    await write(hive, "Deploy with update.sh and HIVE_TUNNEL=1");
    await write(hive, "SQLite migrations run on start");
    await write(hive, "Use node:test for tests");
    await write(hive, "Deploy the other app by hand", "other");
    assert.deepEqual(await found(hive, "triển khai"), [], "no vectors yet: words only");

    assert.equal(await hive.indexMemory(), 4);
    assert.equal(await hive.indexMemory(), 0, "nothing left");
    assert.deepEqual(await found(hive, "triển khai"), ["Deploy with update.sh and HIVE_TUNNEL=1"], "by meaning, in this project only");
    assert.deepEqual(await found(hive, "kiểm thử"), ["Use node:test for tests"]);
    const both = await found(hive, "migration dữ liệu");
    assert.equal(both[0], "SQLite migrations run on start", "found by words and by meaning");
    assert.ok(!both.includes("Deploy with update.sh and HIVE_TUNNEL=1"), "unrelated entries stay out");

    const info = await hive.call("memory.searchInfo", {}, claude);
    assert.deepEqual({ ...info, lastIndexedAt: info.lastIndexedAt !== null }, { mode: "hybrid", model: "fake-1", indexed: 4, total: 4, lastError: null, lastIndexedAt: true });
  });

  it("indexes approved entries only, and forgets removed ones", async () => {
    const hive = new SqliteHive(":memory:", { embedder: fakeEmbedder(), memoryRequiresApproval: true });
    const pending = await write(hive, "Release every Friday", "app", claude);
    assert.equal(await hive.indexMemory(), 0);
    await hive.call("memory.approve", { id: pending.id }, admin);
    assert.equal(await hive.indexMemory(), 1);
    assert.deepEqual(await found(hive, "triển khai"), ["Release every Friday"]);
    await hive.call("memory.remove", { id: pending.id }, admin);
    assert.equal((await hive.call("memory.searchInfo", {}, admin)).indexed, 0);
  });

  it("answers from words when the embedder fails, and says so", async () => {
    const hive = new SqliteHive(":memory:", { embedder: fakeEmbedder("fake-1", true) });
    await write(hive, "Deploy with update.sh");
    assert.equal(await hive.indexMemory(), 0);
    assert.deepEqual(await found(hive, "deploy"), ["Deploy with update.sh"]);
    assert.equal((await hive.call("memory.searchInfo", {}, admin)).lastError, "HTTP 500");
  });

  it("indexes again for another model and keeps words-only search without one", async () => {
    const db = new SqliteHive(":memory:", { embedder: fakeEmbedder("fake-1") });
    await write(db, "Deploy with update.sh");
    await db.indexMemory();
    const other = new SqliteHive(db.db, { embedder: fakeEmbedder("fake-2") });
    assert.equal((await other.call("memory.searchInfo", {}, admin)).indexed, 0);
    assert.equal(await other.indexMemory(), 1);
    const plain = new SqliteHive(db.db);
    assert.deepEqual(await plain.call("memory.searchInfo", {}, admin), { mode: "keyword", model: null, indexed: 0, total: 1, lastError: null, lastIndexedAt: null });
    assert.deepEqual(await found(plain, "triển khai"), []);
  });
});

describe("OpenAI-compatible embedder", () => {
  async function endpoint(reply: (body: any) => { status: number; json: unknown }) {
    const seen: Array<{ auth?: string; body: any; path: string }> = [];
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const body = JSON.parse(data);
        seen.push({ auth: req.headers.authorization, body, path: req.url! });
        const r = reply(body);
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.json));
      });
    });
    server.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => server.close() };
  }

  it("posts the texts, orders the answer by index and returns unit vectors", async () => {
    const ep = await endpoint((body) => ({
      status: 200,
      json: { data: body.input.map((_: string, i: number) => ({ index: i, embedding: [3 * (i + 1), 4 * (i + 1)] })).reverse() },
    }));
    const e = openAiEmbedder({ url: `${ep.url}/`, model: "bge-m3", key: "test-key" });
    const [a, b] = await e.embed(["một", "hai"]);
    ep.close();
    assert.deepEqual(ep.seen[0], { auth: "Bearer test-key", body: { model: "bge-m3", input: ["một", "hai"] }, path: "/v1/embeddings" });
    assert.deepEqual([...a!].map((x) => Math.round(x * 10) / 10), [0.6, 0.8]);
    assert.equal(b!.length, 2);
  });

  it("reports failures without the endpoint's own words", async () => {
    const ep = await endpoint(() => ({ status: 500, json: { error: "bad key sk-secret at http://internal" } }));
    await assert.rejects(openAiEmbedder({ url: ep.url, model: "m" }).embed(["x"]), /^Error: HTTP 500$/);
    ep.close();
    const short = await endpoint(() => ({ status: 200, json: { data: [] } }));
    await assert.rejects(openAiEmbedder({ url: short.url, model: "m" }).embed(["x"]), /bad response/);
    short.close();
    await assert.rejects(openAiEmbedder({ url: "http://127.0.0.1:9/v1", model: "m" }).embed(["x"]), /network error/);
  });
});
