import { describe, expect, it } from "vitest";
import { egressRule, normalizeEgressRule } from "./egress.ts";
import { sandboxJobConfig } from "./sandbox.ts";
import { jobOffer } from "./worker-protocol.ts";

// Cú pháp Parse của proxy PR #63 để hai bên từ chối cùng các mục mơ hồ.
describe("egress proxy rule format", () => {
  it.each([
    [" API.OpenAI.com.:00443 ", "api.openai.com:443"],
    ["*.EXAMPLE.com:443", "*.example.com:443"],
    ["bücher.example:443", "xn--bcher-kva.example:443"],
    ["registry.internal", "registry.internal"],
    ["10.1.2.3:8080", "10.1.2.3:8080"],
    ["[10.1.2.3]:8080", "10.1.2.3:8080"],
    ["10.0.0.0/8:443", "10.0.0.0/8:443"],
    ["0.0.0.0/0", "0.0.0.0/0"],
    ["2001:db8::1", "2001:db8::1"],
    ["[2001:db8::/32]:443", "[2001:db8::/32]:443"],
  ])("normalizes %s", (input, expected) => {
    expect(egressRule.safeParse(input).success).toBe(true);
    expect(normalizeEgressRule(input)).toBe(expected);
  });
  it.each([
    "",
    "*",
    "*.127.0.0.1",
    "127.1",
    "2130706433",
    "0x7f000001",
    "01.2.3.4",
    "https://api.openai.com",
    "user@example.com",
    "example.com/path",
    "a b.com",
    "a\nb.com",
    "a.com#comment",
    "a.com:0",
    "a.com:65536",
    "a.com:-1",
    "a.com:+443",
    "a.com:443:80",
    "10.0.0.0/33",
    "10.0.0.0/08",
    "[::ffff:c000:201/120]:443",
    "2001:db8::/129",
    "[::1]",
    "[example.com]:443",
    "fe80::1%eth0",
    "[::ffff:192.0.2.1/120]:443",
    "foo..com",
    "-foo.com",
    "foo-.com",
    "a.com/24",
  ])("rejects ambiguous or invalid rule %s", (input) => {
    expect(egressRule.safeParse(input).success).toBe(false);
  });
});

it("requires sandbox image and policy together while accepting legacy worker jobs", () => {
  const envelope = { type: "job_offer", v: 1, id: "job", runId: "run", attempt: 1, ttl: 30 };
  const sandbox = {
    allowlist: ["api.openai.com:443"],
    image: { baseImage: "node:24", setupScriptHash: "a".repeat(64) },
  };
  expect(sandboxJobConfig.safeParse(sandbox).success).toBe(true);
  expect(jobOffer.safeParse({ ...envelope, spec: { execution: "sandbox", sandbox, kind: "code" } }).success).toBe(true);
  expect(jobOffer.safeParse({ ...envelope, spec: { kind: "code" } }).success).toBe(true);
  expect(jobOffer.safeParse({ ...envelope, spec: { execution: "sandbox" } }).success).toBe(false);
  expect(jobOffer.safeParse({ ...envelope, spec: { execution: "worker", sandbox } }).success).toBe(false);
});
