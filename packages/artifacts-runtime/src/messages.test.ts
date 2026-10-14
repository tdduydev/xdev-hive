import { describe, expect, it } from "vitest";
import { MAX_FRAME_TEXT, parseFrameMessage } from "./messages.ts";

describe("parseFrameMessage", () => {
  it.each([
    { type: "ready" },
    { type: "resize", height: 320.5 },
    { type: "error", kind: "runtime", message: "lỗi" },
    { type: "error", kind: "compile", message: "x".repeat(MAX_FRAME_TEXT) },
    { type: "console", level: "warn", message: "" },
  ])("nhận %j", (message) => {
    expect(parseFrameMessage(message)).toEqual(message);
  });

  it.each([
    null,
    "ready",
    [],
    {},
    { type: "unknown" },
    { type: "ready", extra: 1 },
    { type: "resize", height: "10" },
    { type: "resize", height: -1 },
    { type: "resize", height: Number.POSITIVE_INFINITY },
    { type: "resize", height: 1e9 },
    { type: "error", kind: "runtime", message: "x".repeat(MAX_FRAME_TEXT + 1) },
    { type: "error", kind: "other", message: "x" },
    { type: "console", level: "log", message: "x" },
    { type: "console", level: "error", message: 5 },
    { type: "html", html: "<script>" },
  ])("bỏ %j", (message) => {
    expect(parseFrameMessage(message)).toBeNull();
  });
});
