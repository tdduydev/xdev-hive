import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findHidden, HiveError, stripHidden, type Actor } from "../src/index.ts";
import { SqliteHive } from "../src/node.ts";

// Built from code points so this file never holds a raw hidden character itself.
const ch = (...cps: number[]) => String.fromCodePoint(...cps);
const ZWSP = ch(0x200b);
const RLO = ch(0x202e);
const ZWJ = ch(0x200d);
const admin: Actor = { name: "duy", role: "admin" };
const claude: Actor = { name: "claude@duy", role: "agent" };

const EMOJI = [
  ch(0x1f469, 0x200d, 0x1f4bb), // woman technologist
  ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467), // family
  ch(0x1f44d, 0x1f3fd), // thumbs up, skin tone
  ch(0x2764, 0xfe0f), // red heart
  ch(0x1f3f3, 0xfe0f, 0x200d, 0x1f308), // rainbow flag
  ch(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f), // Scotland
];

const hidden = (e: unknown, key: string) => e instanceof HiveError && e.code === "bad_request" && e.key === key;

describe("hidden characters", () => {
  it("finds each kind with its line and column", () => {
    const text = `# Title\nab${ZWSP}c\nuser ${RLO}nimda\n${ch(0xe0041, 0xe0042)} and ${ch(0xe0100)}`;
    assert.deepEqual(findHidden(text), [
      { kind: "zeroWidth", code: "U+200B", line: 2, column: 3 },
      { kind: "bidi", code: "U+202E", line: 3, column: 6 },
      { kind: "tag", code: "U+E0041", line: 4, column: 1 },
      { kind: "tag", code: "U+E0042", line: 4, column: 2 },
      { kind: "selector", code: "U+E0100", line: 4, column: 8 },
    ]);
    assert.equal(findHidden(text, 2).length, 2);
  });

  it("counts columns in code points, so emoji before it do not shift them", () => {
    assert.deepEqual(findHidden(`${ch(0x1f600)}${ZWSP}`), [{ kind: "zeroWidth", code: "U+200B", line: 1, column: 2 }]);
  });

  it("leaves emoji sequences and ordinary text alone", () => {
    const text = `Tiếng Việt, 日本語, ${EMOJI.join(" ")}`;
    assert.deepEqual(findHidden(text), []);
    assert.equal(stripHidden(text), text);
  });

  it("still catches joiners and tags outside an emoji", () => {
    assert.deepEqual(findHidden(`a${ZWJ}b`).map((h) => h.code), ["U+200D"]);
    assert.deepEqual(findHidden(`${ch(0x1f600)}${ZWJ}`).map((h) => h.code), ["U+200D"]);
    assert.equal(findHidden(ch(0x1f3f4, 0xe0069, 0xe0067, 0xe006e, 0xe006f, 0xe0072, 0xe0065)).length, 6, "tags with no cancel tag");
  });

  it("strips hidden characters and keeps the rest", () => {
    assert.equal(stripHidden(`${ch(0xfeff)}ig${ZWSP}nore ${RLO}this${ch(0x2066)} ${EMOJI[0]}${ch(0xe0041)}`), `ignore this ${EMOJI[0]}`);
  });
});

describe("writes with hidden characters", () => {
  it("are refused for docs, proposals and memory, with where the first one is", async () => {
    const hive = new SqliteHive(":memory:");
    await assert.rejects(
      hive.call("docs.save", { key: "org/style", content: `Tabs\nuse${ZWSP} spaces`, baseVersion: 0 }, admin),
      (e: unknown) => hidden(e, "errors.hidden.zeroWidth") && (e as HiveError).message.includes("line 2, column 4"),
    );
    await assert.rejects(hive.call("docs.save", { key: "org/style", content: "Tabs", title: `Style${RLO}`, baseVersion: 0 }, admin), (e) =>
      hidden(e, "errors.hidden.bidi"),
    );
    const doc = await hive.call("docs.save", { key: "org/style", content: `Tabs ${EMOJI.join("")}`, baseVersion: 0 }, admin);
    assert.equal(doc.version, 1);

    await assert.rejects(
      hive.call("proposals.create", { docKey: "org/style", baseVersion: 1, content: `Tabs${ch(0xe0049)}`, reason: "fix" }, claude),
      (e) => hidden(e, "errors.hidden.tag"),
    );
    await assert.rejects(
      hive.call("proposals.create", { docKey: "org/style", baseVersion: 1, content: "Spaces", reason: `fix${ZWSP}` }, claude),
      (e) => hidden(e, "errors.hidden.zeroWidth"),
    );
    await assert.rejects(hive.call("memory.write", { project: "app", kind: "gotcha", content: `x${ch(0xe0101)}` }, claude), (e) =>
      hidden(e, "errors.hidden.selector"),
    );
    const err = await hive.call("memory.write", { project: "app", kind: "gotcha", content: `a${ZWSP}` }, claude).catch((e: HiveError) => e);
    assert.deepEqual((err as HiveError).vars, { code: "U+200B", line: 1, column: 2 });
  });
});
