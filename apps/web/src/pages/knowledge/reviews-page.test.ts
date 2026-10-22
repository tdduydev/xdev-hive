import { describe, expect, it } from "vitest";
import { wordImageTarget } from "@/pages/knowledge/reviews-page.tsx";

const images = [
  {
    name: "9f2c4b7a1d3e.png",
    mediaType: "image/png",
    bytes: 67,
    url: "/api/v1/docs/word-imports/i/files/f/media/9f2c4b7a1d3e.png",
  },
];

describe("wordImageTarget", () => {
  it("đổi đường dẫn ảnh trong đề xuất Word thành URL route ảnh xem trước kèm org", () => {
    expect(wordImageTarget(images, "media/9f2c4b7a1d3e.png", "https://hub.example", "org a")).toEqual({
      kind: "asset",
      url: "https://hub.example/api/v1/docs/word-imports/i/files/f/media/9f2c4b7a1d3e.png?org=org%20a",
    });
  });
  it("trả null khi không có ảnh trùng tên", () => {
    expect(wordImageTarget(images, "media/khac.png", "https://hub.example", "o")).toBeNull();
    expect(wordImageTarget([], "media/9f2c4b7a1d3e.png", "https://hub.example", "o")).toBeNull();
  });
});
