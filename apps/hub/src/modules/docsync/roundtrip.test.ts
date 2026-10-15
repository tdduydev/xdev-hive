import { readFileSync } from "node:fs";
import { normalizeDoc, scanSecrets } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { contentHash, detectEol, fromLf, hasBom, toLf } from "./content.ts";

type Sample = {
  file: string;
  path: string;
  commit: string;
  sha256: string;
  codecSha256: string;
  codecExact: boolean;
};
const fixtureRoot = new URL("./fixtures/roundtrip/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", fixtureRoot), "utf8")) as {
  files: Sample[];
  codecAudit: { exact: number; total: number; normalized: number };
};

// Hub không phụ thuộc runtime trình soạn. Test đọc đúng bản codec và schema của package đó mà không đổi package.json.
const editorUrl = new URL("../../../../../packages/doc-editor/src/markdown.ts", import.meta.url).href;
const coreUrl = new URL("../../../../../packages/doc-editor/node_modules/@tiptap/core/dist/index.js", import.meta.url)
  .href;
const [{ MarkdownCodec, docExtensions }, { getSchema }] = await Promise.all([import(editorUrl), import(coreUrl)]);
const schema = getSchema(docExtensions());

describe("SC-005: 200 phiên bản Markdown thật từ docs/ và specs/", () => {
  it("bộ mẫu có nguồn gốc Git, nội dung khác nhau và ghi đúng khoảng trống codec hiện có", () => {
    expect(manifest.files.length).toBeGreaterThanOrEqual(200);
    expect(new Set(manifest.files.map((sample) => sample.sha256)).size).toBe(manifest.files.length);
    for (const sample of manifest.files) {
      expect(sample.path).toMatch(/^(?:docs|specs)\/.+\.md$/);
      expect(sample.commit).toMatch(/^[a-f0-9]{40}$/);
    }
    expect(manifest.codecAudit).toMatchObject({ exact: 191, total: 200, normalized: 200 });
    expect(manifest.files.filter((sample) => sample.codecExact)).toHaveLength(manifest.codecAudit.exact);
  });

  for (const sample of manifest.files) {
    it(`${sample.file}: ${sample.path} @ ${sample.commit.slice(0, 8)}`, () => {
      const bytes = readFileSync(new URL(sample.file, fixtureRoot));
      const original = bytes.toString("utf8");
      expect(contentHash(bytes)).toBe(sample.sha256);
      expect(scanSecrets(original)).toEqual([]);
      const lf = toLf(original);
      expect(Buffer.from(fromLf(lf, detectEol(original), hasBom(original))).equals(bytes)).toBe(true);
      // Mỗi mẫu thật cũng kiểm ở cả bốn cách mã hoá, không thay đổi bản gốc được lưu trong fixtures.
      for (const eol of ["lf", "crlf"] as const) {
        for (const bom of [false, true]) {
          const encoded = fromLf(lf, eol, bom);
          expect(
            Buffer.from(fromLf(toLf(encoded), detectEol(encoded), hasBom(encoded))).equals(Buffer.from(encoded)),
          ).toBe(true);
        }
      }
      const codec = new MarkdownCodec();
      const { doc, groups } = codec.parse(lf);
      const node = schema.nodeFromJSON(doc);
      codec.remember(node, groups);
      const output: string = codec.serialize(node);
      expect(output === lf).toBe(sample.codecExact);
      expect(contentHash(output)).toBe(sample.codecSha256);
      // Đây là kiểm hồi quy hành vi hiện có, không xem 9 mẫu bị chuẩn hoá thành đạt round-trip từng byte.
      expect(output).toBe(normalizeDoc(lf));
    });
  }
});
