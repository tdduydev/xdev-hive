import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { HUB_DATA_INVENTORY, hubDataMarkdown } from "./hub-data.ts";

it("tài liệu khớp danh mục, mỗi bảng chỉ khai một lần", () => {
  const tables = HUB_DATA_INVENTORY.flatMap((c) => c.tables);
  expect(new Set(tables).size).toBe(tables.length);
  expect(readFileSync(new URL("../../../docs/hub-data.md", import.meta.url), "utf8").replaceAll("\r\n", "\n")).toBe(
    hubDataMarkdown(),
  );
});
