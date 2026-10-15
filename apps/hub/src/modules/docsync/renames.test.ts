import { describe, expect, it } from "vitest";
import { matchRenames, type RenameFile } from "./renames.ts";

const text = (blocks: string[]) => blocks.join("\n\n");

describe("ghép đổi tên dự phòng", () => {
  it("ưu tiên sha trước nội dung, kể cả file nhị phân", () => {
    const removed = [
      { path: "a.md", blobSha: "sha", content: "a" },
      { path: "img.png", blobSha: "binary" },
    ];
    const added = [
      { path: "b.md", blobSha: "sha", content: "khác" },
      { path: "same.md", content: "a" },
      { path: "img/new.png", blobSha: "binary" },
    ];
    expect(matchRenames(removed, added)).toEqual([
      { from: "a.md", to: "b.md", method: "blob", similarity: 1 },
      { from: "img.png", to: "img/new.png", method: "blob", similarity: 1 },
    ]);
  });

  it("Jaccard theo tập khối nhận ngưỡng 0,8, không nhận thấp hơn", () => {
    const content = text(["a", "b", "c", "d", "e"]);
    expect(matchRenames([{ path: "a", content }], [{ path: "b", content: text(["a", "b", "c", "d"]) }])).toEqual([
      { from: "a", to: "b", method: "blocks", similarity: 0.8 },
    ]);
    expect(matchRenames([{ path: "a", content }], [{ path: "b", content: text(["a", "b", "c", "d", "f"]) }])).toEqual(
      [],
    );
  });

  it("khối lặp không tăng điểm; code có dòng trống vẫn là một khối", () => {
    const content = "# a\n\n```ts\na\n\nb\n```\n\nCuối\n";
    expect(
      matchRenames([{ path: "a", content }], [{ path: "b", content: content.replace(/\n/g, "\r\n") }])[0]?.similarity,
    ).toBe(1);
    expect(matchRenames([{ path: "a", content: "a\n\na\n\na" }], [{ path: "b", content: "a" }])[0]?.similarity).toBe(1);
  });

  it("không đoán rename cho file rỗng hoặc thiếu nội dung và không sha", () => {
    expect(matchRenames([{ path: "a" }, { path: "b", content: "\n \n" }], [{ path: "c", content: "" }])).toEqual([]);
    expect(matchRenames([], [])).toEqual([]);
  });

  it("chọn cặp mạnh nhất trước và mỗi đường dẫn chỉ ghép một lần", () => {
    const removed = [
      { path: "a", content: text(["1", "2", "3", "4", "5"]) },
      { path: "b", content: text(["1", "2", "3", "4"]) },
    ];
    const added = [{ path: "c", content: text(["1", "2", "3", "4"]) }];
    expect(matchRenames(removed, added)).toEqual([{ from: "b", to: "c", method: "blocks", similarity: 1 }]);
  });

  it("sha trùng nhiều file ghép ổn định theo tên, không thay đổi đầu vào", () => {
    const removed: readonly RenameFile[] = Object.freeze([
      Object.freeze({ path: "b", blobSha: "same" }),
      Object.freeze({ path: "a", blobSha: "same" }),
    ]);
    const added = [
      { path: "z", blobSha: "same" },
      { path: "y", blobSha: "same" },
    ];
    expect(matchRenames(removed, added)).toEqual([
      { from: "a", to: "y", method: "blob", similarity: 1 },
      { from: "b", to: "z", method: "blob", similarity: 1 },
    ]);
    expect(matchRenames([...removed].reverse(), [...added].reverse())).toEqual(matchRenames(removed, added));
    expect(removed[0]?.path).toBe("b");
  });

  it("điểm bằng nhau có thứ tự xác định", () => {
    expect(
      matchRenames(
        [
          { path: "b", content: "same" },
          { path: "a", content: "same" },
        ],
        [
          { path: "y", content: "same" },
          { path: "z", content: "same" },
        ],
      ),
    ).toEqual([
      { from: "a", to: "y", method: "blocks", similarity: 1 },
      { from: "b", to: "z", method: "blocks", similarity: 1 },
    ]);
  });
});
