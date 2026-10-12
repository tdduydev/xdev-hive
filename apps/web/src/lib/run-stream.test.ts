import { describe, expect, it } from "vitest";
import { runStreamUrl } from "@/lib/run-stream.ts";

describe("runStreamUrl", () => {
  it("tổ chức đi bằng tham số org", () =>
    expect(runStreamUrl("org-1", "run-1")).toBe("/api/v1/runs/run-1/stream?org=org-1"));
});
