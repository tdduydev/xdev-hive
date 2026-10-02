// Merges asked for on the web (roadmap 18c, asked 2/10): the hub keeps no GitLab or GitHub token, so the run's machine
// merges with its own, as its user would. Only links on the configured GitLab / GitHub, so each token goes nowhere else.
import { HiveError } from "@xdev-hive/core";
import { GitHubClient, pullRef } from "#desktop/main/github/client.ts";
import { GitLabClient } from "./client.ts";
import type { MrHost } from "./mr.ts";
import { mrRef } from "./watch.ts";

export async function mergeMr(host: Pick<MrHost, "gitlab" | "github" | "fetch">, mrUrl: string): Promise<void> {
  const gl = host.gitlab();
  const mr = gl.url && gl.token ? mrRef(gl.url, mrUrl) : null;
  if (mr) {
    await new GitLabClient(gl.url, gl.token, host.fetch).merge(mr.project, mr.iid);
    return;
  }
  const gh = host.github?.();
  const pull = gh?.url && gh.token ? pullRef(gh.url, mrUrl) : null;
  if (gh && pull) {
    const r = await new GitHubClient(gh.url, gh.token, host.fetch).merge(pull.repo, pull.number);
    if (!r.merged) throw new HiveError("bad_request", `GitHub: ${r.message}`);
    return;
  }
  throw new HiveError("bad_request", `${mrUrl} is not on this machine's GitLab or GitHub.`, { key: "errors.mrNotOnForge", vars: { url: mrUrl } });
}
