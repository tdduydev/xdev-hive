import { describe, expect, it } from "vitest";
import { activate, deactivate } from "@/extension.ts";
import { createContext } from "../test/vscode-mock.ts";

describe("extension", () => {
  it("activate với mock không lỗi và đăng ký lệnh showLog", () => {
    const ctx = createContext();
    expect(() => activate(ctx as never)).not.toThrow();
    expect(ctx.subscriptions.length).toBeGreaterThan(0);
    expect(() => deactivate()).not.toThrow();
  });
});
