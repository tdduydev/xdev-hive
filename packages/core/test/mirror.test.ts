import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, parseMirrorConfig, planMirror } from "#core/index.ts";

const files: Record<string, string> = {
  "README.md": "# xDev Hive\n\nGiới thiệu.\n\n## Chạy\n\nnpm ci\n\n## Hub cho team\n\nDocker.\n",
  "docs/roadmap.md": "# Roadmap\n\nMỗi mục một dòng.\n\n## 0. Đa ngôn ngữ (tiếng Việt, tiếng Anh)\n\n- [x] vi\n\n## Tính năng\n\n- [ ] 26\n",
  "docs/deploy.md": "# Triển khai\n\nupdate.sh\n",
};
const read = (f: string) => files[f] ?? null;
const key = (e: unknown) => (e as HiveError).key;

describe("docs mirrored from the repo (roadmap 26)", () => {
  it("makes a page per section under a folder, and a page of a whole file", () => {
    const entries = parseMirrorConfig(
      JSON.stringify({
        docs: [
          { file: "README.md", split: "##", folder: "huong-dan", folderTitle: "Hướng dẫn" },
          { file: "docs/roadmap.md", split: "##", folder: "roadmap", prefix: "roadmap-", short: true, intro: "folder" },
          { file: "docs/deploy.md", key: "trien-khai", parent: "huong-dan" },
          { file: "docs/gone.md", key: "gone" },
        ],
      }),
    );
    const { pages, missing } = planMirror(entries, read);
    assert.deepEqual(missing, ["docs/gone.md"]);
    const by = Object.fromEntries(pages.map((p) => [p.slug, p]));
    assert.deepEqual(Object.keys(by), ["huong-dan", "chay", "hub-cho-team", "roadmap", "roadmap-da-ngon-ngu", "roadmap-tinh-nang", "trien-khai"]);
    assert.deepEqual([by["huong-dan"]!.folder, by["huong-dan"]!.content, by["huong-dan"]!.title], [true, null, "Hướng dẫn"], "the folder keeps its text in Hive");
    assert.deepEqual([by["hub-cho-team"]!.content, by["hub-cho-team"]!.parent, by["hub-cho-team"]!.from], ["Docker.\n", "huong-dan", "README.md#Hub cho team"]);
    assert.equal(by["roadmap-da-ngon-ngu"]!.title, "Đa ngôn ngữ", "short titles drop the number and the brackets");
    assert.equal(by.roadmap!.content, "Mỗi mục một dòng.\n", "the intro as the folder's text");
    assert.deepEqual([by["trien-khai"]!.title, by["trien-khai"]!.parent], ["Triển khai", "huong-dan"]);
  });

  it("refuses a config that is not valid, a page Hive writes into the repo, and two pages of one name", () => {
    assert.throws(() => parseMirrorConfig("{"), (e: unknown) => key(e) === "errors.mirrorConfig");
    assert.throws(() => parseMirrorConfig(JSON.stringify({ docs: [{ file: "../etc/passwd.md", key: "x" }] })), (e: unknown) => key(e) === "errors.mirrorConfig");
    assert.throws(() => parseMirrorConfig(JSON.stringify({ docs: [{ file: "a.txt", key: "x" }] })), (e: unknown) => key(e) === "errors.mirrorConfig");
    const owned = parseMirrorConfig(JSON.stringify({ docs: [{ file: "docs/deploy.md", key: "agents" }] }));
    assert.throws(() => planMirror(owned, read), (e: unknown) => key(e) === "errors.mirrorOwned");
    const twice = parseMirrorConfig(JSON.stringify({ docs: [{ file: "docs/deploy.md", key: "chay" }, { file: "README.md", split: "##", folder: "huong-dan" }] }));
    assert.throws(() => planMirror(twice, read), (e: unknown) => key(e) === "errors.mirrorTwice");
  });
});
