import { describe, expect, it } from "vitest";
import { matchGlob } from "./glob.ts";

describe("matchGlob", () => {
  it.each([
    ["infra/prod/**", "infra/prod/a/b.tf", true],
    ["infra/prod/**", "infra/staging/a.tf", false],
    ["infra/prod", "infra/prod/x", true],
    ["*.env", ".env", true],
    ["*.env", "a/b.env", false],
    ["**/*.pem", "a/b/c.pem", true],
    ["**/*.pem", "c.pem", true],
    ["src/?.ts", "src/a.ts", true],
    ["src/payments/**", "src/payments/refund.ts", true],
    ["src/payments/**", "src/payment.ts", false],
    ["release/*", "release/1.2", true],
    ["release/*", "release/1.2/hotfix", true],
    ["release/*", "main", false],
    ["a.b", "axb", false],
  ])("%s ~ %s → %s", (g, p, want) => expect(matchGlob(g, p)).toBe(want));
});
