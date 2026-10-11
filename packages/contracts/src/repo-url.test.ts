import { describe, expect, it } from "vitest";
import { parseRepoUrl } from "./repo-url.ts";

describe("parseRepoUrl", () => {
  it.each([
    ["https://github.com/xdev-team/billing-api", { host: "github.com", owner: "xdev-team", name: "billing-api" }],
    ["https://github.com/xdev-team/billing-api.git", { host: "github.com", owner: "xdev-team", name: "billing-api" }],
    ["git@github.com:xdev-team/billing-api.git", { host: "github.com", owner: "xdev-team", name: "billing-api" }],
    ["https://gitlab.example.com/a/b/c/web/", { host: "gitlab.example.com", owner: "a/b/c", name: "web" }],
    ["ssh://git@gitlab.example.com:2222/a/web.git", { host: "gitlab.example.com:2222", owner: "a", name: "web" }],
  ])("%s", (url, expected) => expect(parseRepoUrl(url)).toEqual(expected));

  it.each([
    "http://github.com/a/b",
    "https://token@github.com/a/b",
    "https://u:p@github.com/a/b",
    "file:///tmp/a/b",
    "https://github.com/a",
    "https://github.com/a/b?x=1",
    "https://github.com/a/../b",
    "khong-phai-url",
  ])("từ chối %s", (url) => expect(parseRepoUrl(url)).toBeNull());
});
