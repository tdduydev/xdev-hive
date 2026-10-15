import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const at = (path: string) => `${root}${path}`;
const cache = resolve(root, "../../.e2e/vscode-auth");
await mkdir(cache, { recursive: true });
await build({
  entryPoints: [at("src/auth/smoke.electron.ts")],
  outfile: `${cache}/smoke.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  alias: { "@": at("src") },
});
await runTests({
  version: "1.101.0",
  cachePath: cache,
  reuseMachineInstall: false,
  extensionDevelopmentPath: root,
  extensionTestsPath: `${cache}/smoke.cjs`,
  extensionTestsEnv: {
    HIVE_CLI_CONFIG: `${cache}/missing-hive.json`,
    HIVE_WORKER_CONFIG: `${cache}/missing-worker.json`,
  },
  launchArgs: [
    "--user-data-dir",
    `${cache}/user`,
    "--extensions-dir",
    `${cache}/extensions`,
    "--disable-extensions",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
  ],
});
