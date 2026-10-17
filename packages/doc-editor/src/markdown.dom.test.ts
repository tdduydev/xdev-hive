// @vitest-environment jsdom
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { expect, it } from "vitest";
import { docExtensions, MarkdownCodec } from "./markdown.ts";

// Trình soạn chạy có DOM: @tiptap/markdown đổi HTML trong dòng thành node, khác với test Node ở markdown.test.ts.
it.each(["| A |\n| --- |\n| x<br>y |\n", "| A |\n| --- |\n| x<br/>y<br />z |\n", "| A |\n| --- |\n| a <br> b |\n"])(
  "có DOM, bảng có `<br>` vẫn nạp thành bảng và lưu đúng nguyên văn: %j",
  (md) => {
    const codec = new MarkdownCodec();
    const { doc, groups } = codec.parse(md);
    expect(doc.content?.map((n) => n.type)).toEqual(["table"]);
    const node = PMNode.fromJSON(getSchema(docExtensions()), doc);
    codec.remember(node, groups);
    expect(codec.serialize(node)).toBe(md);
  },
);
