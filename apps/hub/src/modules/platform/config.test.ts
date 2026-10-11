import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("mặc định cổng 3000", () => expect(loadConfig({}).port).toBe(3000));
  it("báo lỗi cổng sai", () => expect(() => loadConfig({ HIVE_PORT: "abc" })).toThrow(/HIVE_PORT/));
});
