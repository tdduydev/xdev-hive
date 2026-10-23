import { describe, expect, it } from "vitest";
import { BLOB_MEDIA_TYPES, blobTypeOf, isBlobType } from "./blob-types.ts";

describe("loại tệp của artifact", () => {
  it("ảnh PNG/JPEG/GIF/WebP là image, PDF là pdf", () => {
    for (const mime of BLOB_MEDIA_TYPES.image) expect(blobTypeOf(mime)).toBe("image");
    expect(blobTypeOf("application/pdf")).toBe("pdf");
  });

  it("SVG và loại khác không thành artifact tệp: SVG đi qua khung như chữ", () => {
    for (const mime of ["image/svg+xml", "text/html", "application/zip", "application/octet-stream", ""])
      expect(blobTypeOf(mime)).toBeNull();
  });

  it("isBlobType chỉ đúng với image và pdf", () => {
    expect(isBlobType("image")).toBe(true);
    expect(isBlobType("pdf")).toBe(true);
    for (const type of ["html", "svg", "markdown", "csv", "json"] as const) expect(isBlobType(type)).toBe(false);
  });
});
