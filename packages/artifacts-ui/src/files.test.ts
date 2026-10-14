import { describe, expect, it } from "vitest";
import { artifactFileName, sourceLanguage } from "./files.ts";

describe("artifactFileName", () => {
  it("đuôi theo loại, code theo ngôn ngữ, bỏ ký tự hệ điều hành cấm", () => {
    expect(artifactFileName({ title: "Luồng hoàn tiền", type: "mermaid", language: null })).toBe("Luồng hoàn tiền.mmd");
    expect(artifactFileName({ title: "a/b:c*?", type: "react", language: null })).toBe("a b c.tsx");
    expect(artifactFileName({ title: "fee", type: "code", language: "Python" })).toBe("fee.py");
    expect(artifactFileName({ title: "fee", type: "code", language: "zig" })).toBe("fee.txt");
    expect(artifactFileName({ title: "  ", type: "markdown", language: null })).toBe("artifact.md");
  });

  it("ngôn ngữ tô màu khi xem nguồn", () => {
    expect(sourceLanguage({ type: "react", language: null })).toBe("tsx");
    expect(sourceLanguage({ type: "code", language: "go" })).toBe("go");
    expect(sourceLanguage({ type: "csv", language: null })).toBeNull();
  });
});
