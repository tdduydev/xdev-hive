import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { appPreview, assertPreviewCurrent, previewEnv } from "#scripts/app-preview.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "preview-test-"));
  roots.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Preview Test");
  git("config", "user.email", "preview@example.test");
  git("config", "commit.gpgSign", "false");
  writeFileSync(join(repo, "app.txt"), "base");
  git("add", "."); git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  git("checkout", "-qb", "review/test");
  writeFileSync(join(repo, "app.txt"), "preview");
  git("commit", "-qam", "preview");
  const sha = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  const gate = { sha, checks: [{ name: "test", status: "passed" }] };
  const scope = { repo, sourceRef: "review/test", sha, target: "main", baseSha, gate, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  // The fixture returns its SHA over HTTP, so approval exercises the actual detached checkout.
  const server = [process.execPath, ["--input-type=module", "-e", `
    import { createServer } from 'node:http';
    import { execFileSync } from 'node:child_process';
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
    createServer((req,res) => {res.setHeader('content-type','application/json'); res.end(JSON.stringify({sha, cwd:process.cwd(), db:process.env.HIVE_DB}));})
      .listen(Number(process.env.HIVE_PORT), process.env.HIVE_HOST);
  `]];
  return { git, scope, options: { ...scope, steps: [], server, confirm: async () => "" } };
}

it("approves the exact gated SHA in a disposable checkout and removes process, DB, token and worktree", async () => {
  const f = fixture();
  let url = "", checkout = "", privateDir = "";
  const receipt = await appPreview({ ...f.options, confirm: async (p: any) => {
    url = p.url;
    const response = await (await fetch(url)).json();
    assert.equal(response.sha, f.scope.sha);
    checkout = response.cwd;
    privateDir = response.db.slice(0, -"/hub.db".length);
    assert.notEqual(checkout, f.scope.repo);
    assert.equal(statSync(privateDir).mode & 0o777, 0o700);
    assert.equal(statSync(p.loginFile).mode & 0o777, 0o600);
    assert.match(readFileSync(p.loginFile, "utf8"), /^[a-f0-9]{64}\n$/);
    assert.equal(f.git("rev-parse", "main"), f.scope.baseSha);
    return p.sha;
  }});
  assert.equal(receipt.status, "approved");
  assert.equal(receipt.sha, f.scope.sha);
  assert.equal(receipt.gateSha, f.scope.sha);
  assert.ok(receipt.approvedAt);
  assert.equal(existsSync(privateDir), false);
  assert.equal(existsSync(checkout), false);
  assert.equal(f.git("worktree", "list", "--porcelain").includes(checkout), false);
  assert.equal(f.git("rev-parse", "main"), f.scope.baseSha);
  assert.equal(f.git("rev-parse", "review/test"), f.scope.sha);
  await assert.rejects(fetch(url));
});

it("rejects stale source, stale target, expired TTL, missing/red/different-SHA gates and invalid TTL", async () => {
  const f = fixture();
  assert.doesNotThrow(() => assertPreviewCurrent(f.scope));
  const oldGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = "/nonexistent-preview-override";
  try { assert.doesNotThrow(() => assertPreviewCurrent(f.scope)); }
  finally { if (oldGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldGitDir; }
  for (const gate of [null, { sha: "b".repeat(40), checks: f.scope.gate.checks }, { sha: f.scope.sha, checks: [] }, { sha: f.scope.sha, checks: [{ status: "failed" }] }])
    assert.throws(() => assertPreviewCurrent({ ...f.scope, gate }), /green gates/);
  assert.throws(() => assertPreviewCurrent({ ...f.scope, expiresAt: "invalid" }), /expired/);
  assert.throws(() => assertPreviewCurrent(f.scope, Date.parse(f.scope.expiresAt)), /expired/);
  f.git("update-ref", "refs/heads/review/test", f.scope.baseSha);
  assert.throws(() => assertPreviewCurrent(f.scope), /source SHA is stale/);
  f.git("update-ref", "refs/heads/review/test", f.scope.sha);
  f.git("update-ref", "refs/heads/main", f.scope.sha);
  assert.throws(() => assertPreviewCurrent(f.scope), /target SHA is stale/);
  await assert.rejects(appPreview({ ...f.options, ttlMinutes: 0 }), /TTL/);
  await assert.rejects(appPreview({ ...f.options, ttlMinutes: 121 }), /TTL/);
});

it("rejects approval after branch movement and cleans up on failure", async () => {
  const f = fixture();
  let directory = "";
  await assert.rejects(appPreview({ ...f.options, confirm: async (p: any) => {
    directory = p.loginFile.replace(/\/login.txt$/, "");
    f.git("update-ref", "refs/heads/review/test", f.scope.baseSha);
    return p.sha;
  }}), /source SHA is stale/);
  assert.equal(existsSync(directory), false);
  assert.equal(f.git("worktree", "list", "--porcelain").includes("hive-preview-"), false);
});

it("does not approve a modified checkout or a rejected SHA", async () => {
  const f = fixture();
  const rejected = await appPreview({ ...f.options, confirm: async () => "no" });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.approvedAt, null);
  await assert.rejects(appPreview({ ...f.options, confirm: async (p: any) => {
    const { cwd } = await (await fetch(p.url)).json();
    writeFileSync(join(cwd, "app.txt"), "modified");
    return p.sha;
  }}), /checkout changed/);
});

it("stops a live preview on cancellation and cleans up failed build/startup", async () => {
  const f = fixture();
  const controller = new AbortController();
  let directory = "";
  await assert.rejects(appPreview({ ...f.options, signal: controller.signal, confirm: async (p: any) => {
    directory = p.loginFile.replace(/\/login.txt$/, "");
    controller.abort();
    return p.sha;
  }}), /stopped/);
  assert.equal(existsSync(directory), false);
  await assert.rejects(appPreview({ ...f.options, steps: [[process.execPath, ["-e", "process.exit(7)"]]] }), /command failed/);
  await assert.rejects(appPreview({ ...f.options, server: ["/nonexistent-preview-server", []] }), /stopped/);
  assert.equal(f.git("worktree", "list", "--porcelain").includes("hive-preview-"), false);
});

it("uses an isolated loopback environment without production credentials", () => {
  process.env.HIVE_DB = "/production.db";
  process.env.HIVE_TOKEN = "test-private";
  try {
    const env = previewEnv("/temporary", 8888, "a".repeat(40));
    assert.equal(env.HIVE_HOST, "127.0.0.1");
    assert.equal(env.HIVE_DB, "/temporary/hub.db");
    assert.equal(env.HIVE_TOKEN, undefined);
  } finally { delete process.env.HIVE_DB; delete process.env.HIVE_TOKEN; }
});

it("expires a hanging build at the TTL and cleans its private checkout", { timeout: 90_000 }, async () => {
  const f = fixture();
  await assert.rejects(appPreview({ ...f.options, ttlMinutes: 1,
    steps: [[process.execPath, ["-e", "setInterval(() => {}, 1000)"]]],
  }), /Preview expired/);
  assert.equal(f.git("rev-parse", "main"), f.scope.baseSha);
  assert.equal(f.git("worktree", "list", "--porcelain").includes("hive-preview-"), false);
});
