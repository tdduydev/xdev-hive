import { describe, expect, it } from "vitest";
import { parsePatch, patchLineCount } from "./patch.ts";

const patch = [
  "@@ -10,4 +10,5 @@ function refund()",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " return a;",
  "\\ No newline at end of file",
  "@@ -40,2 +41,2 @@",
  " x",
  "-y",
  "+z",
].join("\n");

describe("parsePatch", () => {
  it("gắn số dòng cũ và mới theo từng hunk", () => {
    const lines = parsePatch(patch);
    expect(lines.map((l) => (l.kind === "hunk" ? "@" : `${l.kind}:${l.oldNo}:${l.newNo}`))).toEqual([
      "@",
      "context:10:10",
      "del:11:null",
      "add:null:11",
      "add:null:12",
      "context:12:13",
      "@",
      "context:40:41",
      "del:41:null",
      "add:null:42",
    ]);
  });

  it("bỏ dòng 'No newline' và phần đầu trước hunk", () => {
    expect(
      parsePatch("diff --git a b\n--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n"),
    ).toHaveLength(3);
  });

  it("không có hunk thì rỗng", () => {
    expect(parsePatch("")).toEqual([]);
  });
});

describe("patchLineCount", () => {
  it("đếm dòng", () => {
    expect(patchLineCount("a")).toBe(1);
    expect(patchLineCount("a\nb\nc")).toBe(3);
  });
});
