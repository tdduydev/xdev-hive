import { describe, expect, it } from "vitest";
import { type HubProject, matchProject, normalizeRepo } from "@/lib/hub.ts";

const PROJECT: HubProject = {
  key: "PAY",
  name: "payment-api",
  state: "active",
  repo: {
    kind: "github",
    owner: "acme",
    name: "payment-api",
    httpUrl: "https://github.com/acme/payment-api.git",
    sshUrl: "git@github.com:acme/payment-api.git",
    webUrl: "https://github.com/acme/payment-api",
  },
};

describe("so thư mục với dự án", () => {
  it("https và ssh của cùng một repo khớp nhau", () => {
    expect(normalizeRepo("https://github.com/Acme/payment-api.git")).toBe("github.com/acme/payment-api");
    expect(normalizeRepo("git@github.com:acme/payment-api.git")).toBe("github.com/acme/payment-api");
    expect(normalizeRepo("ssh://git@github.com/acme/payment-api")).toBe("github.com/acme/payment-api");
    expect(matchProject("git@github.com:acme/payment-api.git", [PROJECT])?.key).toBe("PAY");
    expect(matchProject("git@github.com:acme/other.git", [PROJECT])).toBeNull();
    expect(matchProject(null, [PROJECT])).toBeNull();
  });
});
