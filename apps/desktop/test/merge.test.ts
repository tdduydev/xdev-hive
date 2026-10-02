import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gitlabSettingsSchema, githubSettingsSchema } from "@xdev-hive/core/node";
import { mergeMr } from "#desktop/main/gitlab/merge.ts";

function host(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string> });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  return {
    calls,
    host: {
      gitlab: () => gitlabSettingsSchema.parse({ url: "https://gitlab.example", token: "glpat-test" }),
      github: () => githubSettingsSchema.parse({ url: "https://github.com", token: "ghp-test" }),
      fetch,
    },
  };
}

describe("merging an MR from the web (roadmap 18c)", () => {
  it("merges a GitLab MR with the machine's GitLab token", async () => {
    const h = host([{ status: 200, body: { iid: 7, state: "merged" } }]);
    await mergeMr(h.host, "https://gitlab.example/team/app/-/merge_requests/7");
    assert.equal(h.calls[0]!.method, "PUT");
    assert.equal(h.calls[0]!.url, "https://gitlab.example/api/v4/projects/team%2Fapp/merge_requests/7/merge");
    assert.equal(h.calls[0]!.headers["PRIVATE-TOKEN"], "glpat-test");
  });

  it("merges a GitHub PR with the machine's GitHub token, and says why it could not", async () => {
    const h = host([{ status: 200, body: { merged: true, message: "Pull Request successfully merged" } }, { status: 405, body: { message: "Pull Request is not mergeable" } }]);
    await mergeMr(h.host, "https://github.com/duy/app/pull/3");
    assert.equal(h.calls[0]!.url, "https://api.github.com/repos/duy/app/pulls/3/merge");
    assert.equal(h.calls[0]!.headers.authorization, "Bearer ghp-test");
    await assert.rejects(mergeMr(h.host, "https://github.com/duy/app/pull/3"), /405: Pull Request is not mergeable/);
  });

  it("keeps the GitLab error, and never sends a token to a forge it was not set up for", async () => {
    const h = host([{ status: 405, body: { message: "405 Method Not Allowed" } }]);
    await assert.rejects(mergeMr(h.host, "https://gitlab.example/team/app/-/merge_requests/7"), /GitLab 405/);
    await assert.rejects(mergeMr(h.host, "https://evil.example/team/app/-/merge_requests/7"), /not on this machine's GitLab or GitHub/);
    assert.equal(h.calls.length, 1);
  });
});
