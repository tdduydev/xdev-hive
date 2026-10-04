// Reference repos of a run (roadmap 38h): resolved from the project's settings, read by the agent, never written to.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_TEMPLATES, type DesktopProject } from "@xdev-hive/core";
import { buildCommand, buildPrompt, claudeDenyWrites } from "#desktop/main/runner/command.ts";
import { containerCommand } from "#desktop/main/runner/container.ts";
import { describeReferences, resolveReferences, type ReferenceRepo } from "#desktop/main/runner/references.ts";

const projects: DesktopProject[] = [
  { name: "his-service", repo: "/code/his/backend/his-service" },
  { name: "his-service-old", repo: "/code/his/backend/his-service-old" },
  { name: "his-portal", repo: "/code/his/frontend/his-portal" },
];

const heads: Record<string, { branch: string; sha: string }> = {
  "/code/his/backend/his-service-old": { branch: "dev", sha: "9f1c0d4e6b7a8c9d0e1f2a3b4c5d6e7f80912345" },
  "/code/his/frontend/his-portal": { branch: "main", sha: "1111111111111111111111111111111111111111" },
};
const read = (dir: string) => heads[dir] ?? null;

const refs: ReferenceRepo[] = [{ project: "his-service-old", path: "/code/his/backend/his-service-old", branch: "dev", sha: "9f1c0d4e6b7a8c9d0e1f2a3b4c5d6e7f80912345" }];

describe("reference repos (roadmap 38h)", () => {
  it("resolves a project's references to its checkout, branch and commit, and skips what it cannot use", () => {
    const out = resolveReferences(["his-service-old", "his-service-old", "gone", "his-portal"], projects, (dir) => (dir.includes("portal") ? null : read(dir)));
    assert.deepEqual(out.repos, refs, "named twice, taken once; the repo without a git checkout left out");
    assert.deepEqual(out.skipped, [
      { project: "gone", reason: "not on this machine" },
      { project: "his-portal", reason: "no git repo at /code/his/frontend/his-portal" },
    ]);
    assert.deepEqual(resolveReferences(undefined, projects, read), { repos: [], skipped: [] });
    assert.equal(describeReferences(resolveReferences([], projects, read)), null, "no line in the run log when there are none");
    assert.equal(
      describeReferences(out),
      "# references (read-only): his-service-old /code/his/backend/his-service-old (dev 9f1c0d4e6b) · gone: not on this machine · his-portal: no git repo at /code/his/frontend/his-portal",
    );
  });

  it("gives Claude Code the folder to read and rules that refuse writing in it", () => {
    const vars = { prompt: "Do T-1", worktree: "/wt", task: "T-1", project: "his-service", branch: "ai/T-1", references: refs };
    const { args } = buildCommand(AGENT_TEMPLATES.claude, vars);
    const dirs = args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]!] : []));
    assert.deepEqual(dirs, ["/wt", "/code/his/backend/his-service-old"], "the worktree stays first");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    assert.deepEqual(settings.permissions.allow, ["mcp__xdev-hive"], "the reference changes nothing about the tools allowed");
    // Both forms of the path: Claude Code may read a pattern starting with "/" as relative to the settings file.
    assert.deepEqual(settings.permissions.deny, [
      "Write(/code/his/backend/his-service-old/**)",
      "Edit(/code/his/backend/his-service-old/**)",
      "MultiEdit(/code/his/backend/his-service-old/**)",
      "NotebookEdit(/code/his/backend/his-service-old/**)",
      "Write(//code/his/backend/his-service-old/**)",
      "Edit(//code/his/backend/his-service-old/**)",
      "MultiEdit(//code/his/backend/his-service-old/**)",
      "NotebookEdit(//code/his/backend/his-service-old/**)",
    ]);
    const bare = buildCommand(AGENT_TEMPLATES.claude, { ...vars, references: [] }).args;
    const plain = JSON.parse(bare[bare.indexOf("--settings") + 1]!);
    assert.equal(plain.permissions.deny, undefined, "a run without references keeps the settings it had");
    assert.deepEqual(claudeDenyWrites(["D:\\Codes\\his-service-old\\"]).slice(0, 2), ["Write(D:/Codes/his-service-old/**)", "Edit(D:/Codes/his-service-old/**)"], "Windows separators");
  });

  it("gives Codex nothing on the command line, so its sandbox never gains a writable folder", () => {
    const vars = { prompt: "Do T-1", worktree: "/wt", task: "T-1", project: "his-service", branch: "ai/T-1" };
    const without = buildCommand(AGENT_TEMPLATES.codex, vars).args;
    const with_ = buildCommand(AGENT_TEMPLATES.codex, { ...vars, references: refs }).args;
    assert.deepEqual(with_, without);
    assert.ok(!with_.some((a) => a.includes("writable_roots") || a.includes("his-service-old")), "no write grant, no folder of its own");
  });

  it("mounts a reference repo read-only in a container, and never a path the run already has", () => {
    const c = containerCommand({
      profile: { ...AGENT_TEMPLATES.claude, container: { image: "xdev-hive-agent", network: "open", allow: [] } },
      args: ["-p", "do it"],
      stdin: null,
      runId: "R-abc123",
      worktree: "/work/his-service/T-1",
      gitDir: "/code/his/backend/his-service/.git",
      env: {},
      readOnly: ["/data/runs/R-abc123.mcp.json", "/code/his/backend/his-service-old", "/work/his-service/T-1"],
      home: "/home/duy",
      user: null,
      exists: () => false,
    });
    const mounts = c.args.flatMap((a, i) => (a === "-v" ? [c.args[i + 1]!] : []));
    assert.deepEqual(mounts, [
      "/work/his-service/T-1:/work/his-service/T-1",
      "/code/his/backend/his-service/.git:/code/his/backend/his-service/.git",
      "/data/runs/R-abc123.mcp.json:/data/runs/R-abc123.mcp.json:ro",
      "/code/his/backend/his-service-old:/code/his/backend/his-service-old:ro",
    ]);
  });

  it("tells the agent the path, branch and commit of each reference, and whose conventions still hold", () => {
    const base = {
      project: "his-service",
      taskId: "T-1",
      title: "Nhập dữ liệu",
      note: null,
      role: "implement" as const,
      instructions: "",
      worktree: "/wt",
      branch: "ai/T-1",
      baseSha: "abcdef1234567890",
      attempt: 1,
      previous: null,
    };
    const text = buildPrompt({ ...base, references: refs });
    assert.match(text, /- his-service-old: \/code\/his\/backend\/his-service-old \(branch dev, commit 9f1c0d4e6b\)/);
    assert.match(text, /never edit, create or delete a file there/);
    // --add-dir loads those repos' CLAUDE.md and AGENTS.md: they are another project's, and say so.
    assert.match(text, /keep to project key "his-service"/);
    assert.ok(!buildPrompt(base).includes("Reference repositories"), "nothing said when the project has none");
    // The reviewer and the best-of-n judge read the old code too.
    for (const role of ["review", "plan"] as const) assert.match(buildPrompt({ ...base, role, references: refs }), /Reference repositories on this machine/);
  });
});
