import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { DesktopProject, GitLabGroupRepo, HiveSystem, SystemSource } from "@xdev-hive/core";
import { diffSource, initSystem, linkSource, memberDir, planSystemInit, suggestRoot, urlNamesMember } from "#desktop/main/system-init.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "hive-system-init-"));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const HOST = "gitlab.fis.example";
const repo = (p: string, id = 1): GitLabGroupRepo => ({ id, name: p.split("/").at(-1)!, pathWithNamespace: p, defaultBranch: "main", sshUrl: `git@${HOST}:${p}.git`, httpUrl: `https://${HOST}/${p}.git` });
const member = (project: string, p: string, state: "active" | "archived" | "gone" = "active") => ({ project, ...(({ pathWithNamespace, sshUrl, httpUrl, defaultBranch }) => ({ pathWithNamespace, sshUrl, httpUrl, defaultBranch }))(repo(p)), state });
// ehospital-ai as it stood on 10/10: seven members, system-portal taken out (no permission).
const EHOSPITAL = [
  member("his-service", "ehospital-ai/his/backend/his-service"),
  member("his-service-old", "ehospital-ai/his/backend/his-service-old"),
  member("his-portal", "ehospital-ai/his/frontend/his-portal"),
  member("system-portal-v2", "ehospital-ai/his/frontend/system-portal-v2"),
  member("ui-component", "ehospital-ai/his/frontend/ui-component"),
  member("keycloak-theme", "ehospital-ai/iam/keycloak-theme"),
  member("infa", "ehospital-ai/deploy/infa"),
];
const source = (members = EHOSPITAL): SystemSource => ({ forge: "gitlab", url: `https://${HOST}`, groupPath: "ehospital-ai", members, syncedAt: null });
const system = (projects = EHOSPITAL.map((m) => m.project), src: SystemSource | null = source()): HiveSystem => ({ name: "ehospital-ai", projects, source: src, updatedAt: "", updatedBy: "" });

describe("setting a system's group up on a machine", () => {
  it("a new machine: every member cloned into the group's tree, top level last", () => {
    const root = tmp();
    const plan = planSystemInit(system(), root, [], []);
    assert.deepEqual(plan.map((i) => [i.project, path.relative(root, i.dir!), i.state]), [
      ["infa", path.join("deploy", "infa"), "new"],
      ["his-service", path.join("his", "backend", "his-service"), "new"],
      ["his-service-old", path.join("his", "backend", "his-service-old"), "new"],
      ["his-portal", path.join("his", "frontend", "his-portal"), "new"],
      ["system-portal-v2", path.join("his", "frontend", "system-portal-v2"), "new"],
      ["ui-component", path.join("his", "frontend", "ui-component"), "new"],
      ["keycloak-theme", path.join("iam", "keycloak-theme"), "new"],
    ]);
  });

  it("reuses the clone where the tree puts it, never the e2e copy of the same remote", () => {
    const root = tmp();
    const tree = path.join(root, "his", "backend", "his-service");
    const e2e = path.join(root, "his", "backend", "his-service-e2e");
    const only = system(["his-service"], source([EHOSPITAL[0]!]));
    const remote = EHOSPITAL[0]!.sshUrl;
    assert.deepEqual(planSystemInit(only, root, [], [{ dir: e2e, remote }, { dir: tree, remote }]).map((i) => [i.dir, i.state]), [[tree, "folder"]]);
    // Without the tree's own clone the e2e copy is still not the service: a fresh clone goes where the tree says.
    assert.deepEqual(planSystemInit(only, root, [], [{ dir: e2e, remote }]).map((i) => [i.dir, i.state]), [[tree, "new"]]);
    // A clone under its own name elsewhere (the old flat layout) is reused.
    const flat = path.join(root, "his-service");
    assert.deepEqual(planSystemInit(only, root, [], [{ dir: flat, remote }]).map((i) => [i.dir, i.state]), [[flat, "folder"]]);
  });

  it("knows what the machine has, what is in the way, what left the group and what has no URL", () => {
    const root = tmp();
    mkdirSync(path.join(root, "iam", "keycloak-theme"), { recursive: true });
    const members = [EHOSPITAL[0]!, { ...EHOSPITAL[5]! }, member("old-api", "ehospital-ai/old-api", "archived")];
    const plan = planSystemInit(system(["his-service", "keycloak-theme", "old-api", "manual"], source(members)), root, [{ name: "his-service", repo: "/work/his-service" }], []);
    // Tree order: what sits at the top of the group (or has no path) first.
    assert.deepEqual(plan.map((i) => [i.project, i.state]), [["manual", "unknown"], ["old-api", "gone"], ["his-service", "added"], ["keycloak-theme", "conflict"]]);
  });

  it("finds the root the members already sit under, by their place in the tree", () => {
    const root = path.join(tmp(), "Codes", "ehospital-ai");
    const projects: DesktopProject[] = [
      { name: "his-service", repo: path.join(root, "his", "backend", "his-service") },
      { name: "infa", repo: path.join(root, "deploy", "infa") },
      { name: "keycloak-theme", repo: path.join(tmp(), "keycloak-theme") },
    ];
    assert.equal(suggestRoot(system(), projects), root);
    assert.equal(suggestRoot(system(), []), null);
  });

  it("a member's folder never leaves the root", () => {
    const root = tmp();
    assert.equal(memberDir(root, source(), EHOSPITAL[0]!), path.join(root, "his", "backend", "his-service"));
    assert.equal(memberDir(root, source(), { ...EHOSPITAL[0]!, pathWithNamespace: "elsewhere/x" }), path.join(root, "x"));
  });

  it("clones only a URL that names the member, and registers each under the system's key", async () => {
    assert.equal(urlNamesMember(`https://${HOST}/gitlab/ehospital-ai/iam/keycloak-theme.git`, EHOSPITAL[5]!), true, "prefixed self-hosted");
    assert.equal(urlNamesMember(`https://${HOST}/attacker/keycloak-theme.git`, EHOSPITAL[5]!), false);
    assert.equal(urlNamesMember("ext::sh -c x", EHOSPITAL[5]!), false);
    const root = tmp();
    const bad = { ...EHOSPITAL[6]!, httpUrl: `https://${HOST}/attacker/infa.git` };
    const added: DesktopProject[] = [];
    const cloned: string[] = [];
    const results = await initSystem(system(["infa", "keycloak-theme"], source([bad, EHOSPITAL[5]!])), root, "https", [], {
      projects: () => added,
      add: (p) => void added.push(p),
      clone: async (url, dir) => { cloned.push(`${url} ${path.relative(root, dir)}`); mkdirSync(dir, { recursive: true }); },
      remote: () => null,
    });
    assert.deepEqual(results.map((r) => [r.key, r.ok, r.cloned]), [["infa", false, false], ["keycloak-theme", true, true]]);
    assert.deepEqual(cloned, [`https://${HOST}/ehospital-ai/iam/keycloak-theme.git ${path.join("iam", "keycloak-theme")}`]);
    assert.deepEqual(added, [{ name: "keycloak-theme", repo: path.join(root, "iam", "keycloak-theme"), gitlabProject: "ehospital-ai/iam/keycloak-theme", targetBranch: "main" }]);
  });
});

describe("syncing a system with its group", () => {
  const NOW = "2026-10-10T08:00:00.000Z";
  it("a repo new to the group joins under a free key; one taken out by a person stays out", () => {
    const members = [...EHOSPITAL, member("system-portal", "ehospital-ai/his/frontend/system-portal")];
    const repos = [...members.map((m) => repo(m.pathWithNamespace)), repo("ehospital-ai/his/backend/his-gateway"), repo("ehospital-ai/iam/infa")];
    const diff = diffSource(system(), source(members), repos, new Set(), ["his-gateway"], NOW);
    // his-gateway is a project of the hub already, infa a member: each new one gets its group in front.
    assert.deepEqual(diff.added, ["backend-his-gateway", "iam-infa"]);
    assert.ok(!diff.projects.includes("system-portal"), "removed by a person: not added back");
    assert.ok(diff.added.every((k) => diff.projects.includes(k)));
    assert.equal(diff.source.syncedAt, NOW);
    assert.equal(diff.changed, true);
    assert.equal(diffSource(system(), source(), EHOSPITAL.map((m) => repo(m.pathWithNamespace)), new Set(), [], NOW).changed, false, "nothing new: only syncedAt");
  });

  it("marks a member archived or gone, keeps it in the system, and brings it back when listed again", () => {
    const repos = EHOSPITAL.filter((m) => m.project !== "his-service-old" && m.project !== "infa").map((m) => repo(m.pathWithNamespace));
    const diff = diffSource(system(), source(), repos, new Set(["ehospital-ai/his/backend/his-service-old"]), [], NOW);
    assert.deepEqual(diff.gone, ["his-service-old", "infa"]);
    assert.deepEqual(diff.source.members.filter((m) => m.state !== "active").map((m) => [m.project, m.state]), [["his-service-old", "archived"], ["infa", "gone"]]);
    assert.deepEqual(diff.projects, [...EHOSPITAL.map((m) => m.project)].sort(), "still in the system");
    const back = diffSource(system(), diff.source, EHOSPITAL.map((m) => repo(m.pathWithNamespace)), new Set(), [], NOW);
    assert.deepEqual(back.back, ["his-service-old", "infa"]);
    assert.ok(back.source.members.every((m) => m.state === "active"));
  });

  it("links a hand-made system by the paths, remotes and names this machine knows", () => {
    const repos = [...EHOSPITAL.map((m) => repo(m.pathWithNamespace)), repo("ehospital-ai/his/backend/his-gateway")];
    const projects: DesktopProject[] = [{ name: "his-service", repo: "/nowhere", gitlabProject: "ehospital-ai/his/backend/his-service" }];
    const linked = linkSource(system(["his-service", "infa", "legacy"], null), "gitlab", `https://${HOST}`, "ehospital-ai", repos, projects, () => null, [], NOW);
    assert.deepEqual(linked.matched, ["his-service", "infa"]);
    assert.deepEqual(linked.unmatched, ["legacy"]);
    assert.ok(linked.added.includes("his-gateway") && linked.added.includes("his-portal"));
    assert.ok(linked.projects.includes("legacy"), "an unmatched project stays in the system");
    assert.equal(linked.source.members.find((m) => m.project === "his-service")?.pathWithNamespace, "ehospital-ai/his/backend/his-service");
  });
});
