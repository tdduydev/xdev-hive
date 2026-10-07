// A project's local prepare command can use this helper before committing/pushing its release metadata.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function prepareRelease(manifestText, roadmapText, version, taskIds) {
  const parts = value => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error("Expected a stable semantic version");
    return value.split(".").map(Number);
  };
  const manifest = JSON.parse(manifestText);
  const old = parts(manifest.version); const next = parts(version);
  const changed = next.findIndex((v, i) => v !== old[i]);
  if (changed < 0 || next[changed] < old[changed]) throw new Error("Release version must increase");
  if (!Array.isArray(taskIds) || !taskIds.every(id => typeof id === "string" && /^[\w.-]+$/.test(id))) throw new Error("Invalid task IDs");
  const ids = new Set(taskIds.map(id => id.replace(/^R-/, "")));
  const roadmap = roadmapText.replace(/^(\s*- )\[ \](\s+\*\*([\w.-]+)\.)/gm, (line, prefix, rest, id) => ids.has(id) ? `${prefix}[x]${rest}` : line);
  manifest.version = version;
  return { manifest: `${JSON.stringify(manifest, null, 2)}\n`, roadmap };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [manifest, roadmap] = process.argv.slice(2);
  if (!manifest || !roadmap) throw new Error("Usage: prepare-auto-release.mjs <package.json> <roadmap.md>");
  const output = prepareRelease(readFileSync(manifest, "utf8"), readFileSync(roadmap, "utf8"), process.env.HIVE_RELEASE_VERSION ?? "", JSON.parse(process.env.HIVE_RELEASE_TASKS_JSON ?? "[]"));
  writeFileSync(manifest, output.manifest); writeFileSync(roadmap, output.roadmap);
}
