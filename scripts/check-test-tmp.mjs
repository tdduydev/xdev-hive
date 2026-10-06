import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const parent = join(process.cwd(), ".xdev-hive");
mkdirSync(parent, { recursive: true });
const testTmp = mkdtempSync(join(parent, "test-tmp-"));
const hiveDirs = () => new Set(
  readdirSync(testTmp, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("hive-"))
    .map((entry) => entry.name),
);

try {
  const before = hiveDirs();
  console.log(`hive-* directories in ${testTmp} before npm test: ${before.size}`);
  const test = spawnSync("npm", ["test"], { stdio: "inherit", env: { ...process.env, TMPDIR: testTmp, TMP: testTmp, TEMP: testTmp } });
  const after = hiveDirs();
  const leaked = [...after].filter((name) => !before.has(name));
  console.log(`hive-* directories in ${testTmp} after npm test: ${after.size}`);
  console.log(`New directories left by npm test: ${leaked.length}`);
  if (leaked.length) console.log(`Left behind: ${leaked.join(", ")}`);
  if (test.error) throw test.error;
  process.exitCode = leaked.length ? 1 : test.status ?? 1;
} finally {
  rmSync(testTmp, { recursive: true, force: true });
}
