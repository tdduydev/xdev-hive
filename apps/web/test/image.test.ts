import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repo = path.resolve(import.meta.dirname, "../../..");

/** Where a workspace import points on disk, from the package's `exports` (e.g. @xdev-hive/ui/i18n → packages/ui/src/i18n/translate.ts). */
function resolveExport(spec: string): string {
  const [, scope, name, sub] = /^(@xdev-hive)\/([^/]+)(?:\/(.+))?$/.exec(spec)!;
  void scope;
  const dir = ["packages", "apps"].map((d) => path.join(d, name!)).find((d) => {
    try {
      readFileSync(path.join(repo, d, "package.json"));
      return true;
    } catch {
      return false;
    }
  })!;
  const pkg = JSON.parse(readFileSync(path.join(repo, dir, "package.json"), "utf8")) as { exports?: Record<string, string | Record<string, string>> };
  const entry = pkg.exports?.[sub ? `./${sub}` : "."];
  const file = typeof entry === "string" ? entry : (entry?.default ?? entry?.import ?? "./src/index.ts");
  return path.join(dir, file);
}

describe("hub image", () => {
  it("ships the source of every workspace module the hub server imports", () => {
    const dockerfile = readFileSync(path.join(repo, "Dockerfile"), "utf8");
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    const copied = [...runtime.matchAll(/^COPY (?!--from)(\S+) /gm)].map((m) => m[1]!);
    const specs = new Set<string>();
    for (const f of readdirSync(path.join(repo, "apps/web/src"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"))) {
      for (const m of readFileSync(path.join(repo, "apps/web/src", f), "utf8").matchAll(/from "(@xdev-hive\/[^"]+)"/g)) specs.add(m[1]!);
    }
    const missing = [...specs].map(resolveExport).filter((file) => !copied.some((c) => file === c || file.startsWith(`${c}/`)));
    assert.deepEqual(missing, [], "add a COPY line for these to the runtime stage of the Dockerfile");
  });
});
