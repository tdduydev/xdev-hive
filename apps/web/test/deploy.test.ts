// The deploy scripts are only ever run on the server, where a syntax error means a hub that is half updated.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..", "..");

describe("deploy scripts", () => {
  for (const script of ["deploy/update.sh", "deploy/restore-drill.sh"]) {
    it(`${script} parses`, async (t) => {
      try {
        await run("bash", ["-n", script], { cwd: repo });
      } catch (err) {
        // No bash on this machine (Windows): nothing to say about the script.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return t.skip("no bash");
        assert.fail(String((err as { stderr?: string }).stderr ?? err));
      }
    });
  }
});
